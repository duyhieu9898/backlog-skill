import { loadAgentConfig, type ScheduledCheckConfig } from "./config/app";
import {
  loadCommandCatalog,
  runTrackedCommand,
  type AgentCommand,
  type CommandCatalog,
} from "./commands";
import { generateTraceId } from "./logging/trace";
import { log } from "./logging/logger";
import { nowIso, setJsonState } from "./storage/repositories";
import { tailLines } from "./utils";

export type ScheduledCheck = {
  name: string;
  label: string;
  intervalMinutes: number;
  enabled: boolean;
  command: AgentCommand;
};

export type ScheduledCheckResult = {
  name: string;
  label: string;
  traceId: string;
  status: "success" | "failed";
  exitCode: number;
  outputTail: string;
  finishedAt: string;
};

export type SchedulerNotifier = (text: string) => Promise<void>;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function loadScheduledChecks(
  configs: ScheduledCheckConfig[] = loadAgentConfig().schedules || [],
  catalog: CommandCatalog = loadCommandCatalog(),
): ScheduledCheck[] {
  return configs.map((config) => normalizeScheduledCheck(config, catalog));
}

export function normalizeScheduledCheck(
  config: ScheduledCheckConfig,
  catalog: CommandCatalog,
): ScheduledCheck {
  const name = config.name?.trim();
  if (!name || !NAME_PATTERN.test(name)) {
    throw new Error(`Scheduled check has invalid name: ${config.name || "(empty)"}`);
  }
  if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 1) {
    throw new Error(`Scheduled check ${name} must use intervalMinutes >= 1.`);
  }
  const command = catalog.byAlias[config.command.toLowerCase()];
  if (!command) throw new Error(`Scheduled check ${name} references unknown command: ${config.command}`);
  if (command.requiresConfirmation || command.externalSideEffect) {
    throw new Error(`Scheduled check ${name} must reference a read-only command.`);
  }

  return {
    name,
    label: config.label?.trim() || command.label,
    intervalMinutes: config.intervalMinutes,
    enabled: config.enabled === true,
    command,
  };
}

export function formatScheduleList(checks: ScheduledCheck[]): string {
  if (!checks.length) return "No scheduled checks configured.";
  return checks
    .map((check) => {
      const state = check.enabled ? "enabled" : "disabled";
      return `${check.name} - ${check.label} [${state}, every ${check.intervalMinutes}m]`;
    })
    .join("\n");
}

export function findScheduledCheck(name: string, checks = loadScheduledChecks()): ScheduledCheck | null {
  return checks.find((check) => check.name === name) || null;
}

export async function runScheduledCheck(input: {
  check: ScheduledCheck;
  chatId: string;
  defaultTimeoutMs?: number;
}): Promise<ScheduledCheckResult> {
  const traceId = generateTraceId();
  log.info(traceId, "schedule.started", {
    name: input.check.name,
    commandName: input.check.command.name,
  });

  try {
    const result = await runTrackedCommand({
      traceId,
      chatId: input.chatId,
      action: input.check.command,
      defaultTimeoutMs: input.defaultTimeoutMs,
    });
    const ok = result.exitCode === 0 && !result.signal;
    const finishedAt = nowIso();
    const scheduledResult: ScheduledCheckResult = {
      name: input.check.name,
      label: input.check.label,
      traceId,
      status: ok ? "success" : "failed",
      exitCode: result.exitCode,
      outputTail: tailLines(result.output, 20).slice(-2000),
      finishedAt,
    };
    setJsonState("runtime_state", "lastScheduledRun", scheduledResult);
    log.info(traceId, ok ? "schedule.completed" : "schedule.failed", scheduledResult);
    return scheduledResult;
  } catch (error) {
    const finishedAt = nowIso();
    const scheduledResult: ScheduledCheckResult = {
      name: input.check.name,
      label: input.check.label,
      traceId,
      status: "failed",
      exitCode: 1,
      outputTail: error instanceof Error ? error.message : String(error),
      finishedAt,
    };
    setJsonState("runtime_state", "lastScheduledRun", scheduledResult);
    log.error(traceId, "schedule.failed", { error });
    return scheduledResult;
  }
}

export function formatScheduledCheckResult(result: ScheduledCheckResult): string {
  return [
    `Scheduled check ${result.status}: ${result.label}`,
    `name: ${result.name}`,
    `traceId: ${result.traceId}`,
    `finished: ${result.finishedAt}`,
    `exit: ${result.exitCode}`,
    "",
    result.outputTail || "(no output)",
  ].join("\n");
}

export class ScheduledCheckRunner {
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly checks: ScheduledCheck[],
    private readonly chatId: string,
    private readonly notify: SchedulerNotifier,
    private readonly defaultTimeoutMs?: number,
  ) {}

  start(): void {
    for (const check of this.checks) {
      if (!check.enabled) continue;
      const timer = setInterval(() => {
        void this.runAndNotify(check);
      }, check.intervalMinutes * 60 * 1000);
      this.timers.push(timer);
    }
  }

  stop(): void {
    while (this.timers.length) {
      const timer = this.timers.pop();
      if (timer) clearInterval(timer);
    }
  }

  async runAndNotify(check: ScheduledCheck): Promise<ScheduledCheckResult> {
    const result = await runScheduledCheck({
      check,
      chatId: this.chatId,
      defaultTimeoutMs: this.defaultTimeoutMs,
    });
    await this.notify(formatScheduledCheckResult(result));
    return result;
  }
}
