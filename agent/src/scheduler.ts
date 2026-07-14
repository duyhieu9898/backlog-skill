import crypto from "node:crypto";

import { loadAgentConfig, type ScheduledCheckConfig } from "./config/app";
import { nextAfter, validateCron } from "./cron";
import {
  loadCommandCatalog,
  withCommandInput,
  type AgentCommand,
  type CommandCatalog,
} from "./commands";
import { generateTraceId } from "./logging/trace";
import { log } from "./logging/logger";
import { AgentRuntime, type ScheduledToolContext } from "./runtime/agentRuntime";
import {
  claimDueScheduledJob,
  deleteRuntimeScheduledJob,
  disableRemovedConfigScheduledJobs,
  getScheduledJob,
  listDueScheduledJobs,
  listScheduledJobs,
  listScheduledRuns,
  nowIso,
  recordScheduledRun,
  setJsonState,
  updateScheduledJobState,
  upsertScheduledJob,
  type ScheduledJobRow,
  type ScheduledRunRow,
} from "./storage/repositories";
import { tailLines } from "./utils";

export type ScheduledCheck = {
  /** Stable persisted schedule ID; currently identical to name for compatibility. */
  id: string;
  name: string;
  source: "config" | "runtime";
  label: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  delivery: "telegram" | "silent";
  notifyOnChangeOnly: boolean;
  prepareEffect?: PrepareEffectConfig;
  command: AgentCommand;
};

export type PrepareEffectConfig = {
  prepareCommand: string;
  prepareInput?: unknown;
  effectCommand: string;
};

export type ScheduledCheckResult = {
  name: string;
  label: string;
  traceId: string;
  status: "success" | "failed";
  exitCode: number;
  outputTail: string;
  outputDigest: string;
  notificationSent: boolean;
  finishedAt: string;
};

export type SchedulerNotifier = (text: string) => Promise<void>;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_TICK_MS = 30_000;
let configSeeded = false;
const schedulerRuntime = new AgentRuntime();

function hashOutput(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parsePrepareEffect(value: string | null): PrepareEffectConfig | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as PrepareEffectConfig;
}

export function seedScheduledJobsFromConfig(
  configs: ScheduledCheckConfig[] = loadAgentConfig().schedules || [],
  catalog: CommandCatalog = loadCommandCatalog(),
): void {
  const activeNames: string[] = [];
  for (const config of configs) {
    const check = normalizeScheduledCheck(config, catalog);
    activeNames.push(check.name);
    upsertScheduledJob({
      name: check.name,
      source: "config",
      label: check.label,
      commandName: check.command.name || check.command.label,
      cronExpr: check.cron,
      timezone: check.timezone,
      enabled: check.enabled,
      delivery: check.delivery,
      notifyOnChangeOnly: check.notifyOnChangeOnly,
      prepareEffect: check.prepareEffect,
      nextRunAt: nextRunAtFor(check),
    });
  }
  disableRemovedConfigScheduledJobs(activeNames);
}

function ensureScheduledJobsSeeded(
  configs: ScheduledCheckConfig[] = loadAgentConfig().schedules || [],
  catalog: CommandCatalog = loadCommandCatalog(),
): void {
  if (configSeeded) return;
  seedScheduledJobsFromConfig(configs, catalog);
  configSeeded = true;
}

export function loadScheduledChecks(
  configs?: ScheduledCheckConfig[],
  catalog: CommandCatalog = loadCommandCatalog(),
): ScheduledCheck[] {
  if (configs) {
    seedScheduledJobsFromConfig(configs, catalog);
  } else {
    ensureScheduledJobsSeeded(loadAgentConfig().schedules || [], catalog);
  }
  return listScheduledJobs().flatMap((row) => {
    const check = safeScheduledCheckFromRow(row, catalog);
    return check ? [check] : [];
  });
}

export function normalizeScheduledCheck(
  config: ScheduledCheckConfig,
  catalog: CommandCatalog,
): ScheduledCheck {
  const name = config.name?.trim();
  if (!name || !NAME_PATTERN.test(name)) {
    throw new Error(`Scheduled check has invalid name: ${config.name || "(empty)"}`);
  }
  const cronError = validateCron(config.cron);
  if (cronError) throw new Error(`Scheduled check ${name} has invalid cron: ${cronError}`);

  const command = catalog.byAlias[config.command.toLowerCase()];
  if (!command) throw new Error(`Scheduled check ${name} references unknown command: ${config.command}`);
  validatePrepareEffect(name, config.prepareEffect, catalog);
  const timezone = config.timezone?.trim() || loadAgentConfig().runtime?.timezone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Scheduled check ${name} has invalid timezone: ${timezone}`);
  }

  return {
    id: name,
    name,
    source: "config",
    label: config.label?.trim() || command.label,
    cron: config.cron,
    timezone,
    enabled: config.enabled === true,
    delivery: config.delivery || "telegram",
    notifyOnChangeOnly: config.notifyOnChangeOnly === true,
    prepareEffect: config.prepareEffect,
    command,
  };
}

export function createRuntimeSchedule(
  config: ScheduledCheckConfig,
  catalog: CommandCatalog = loadCommandCatalog(),
): ScheduledCheck {
  const existing = getScheduledJob(config.name.trim());
  if (existing) {
    throw new Error(existing.source === "config"
      ? `Schedule ${config.name} is owned by config.json.`
      : `Schedule ${config.name} already exists.`);
  }
  const check = normalizeScheduledCheck({ ...config, enabled: config.enabled ?? true }, catalog);
  upsertScheduledJob({
    name: check.name,
    source: "runtime",
    label: check.label,
    commandName: check.command.name || check.command.label,
    cronExpr: check.cron,
    timezone: check.timezone,
    enabled: check.enabled,
    delivery: check.delivery,
    notifyOnChangeOnly: check.notifyOnChangeOnly,
    prepareEffect: check.prepareEffect,
    nextRunAt: nextRunAtFor(check),
  });
  return { ...check, source: "runtime" };
}

export function removeRuntimeSchedule(name: string): boolean {
  return deleteRuntimeScheduledJob(name);
}

function validatePrepareEffect(
  name: string,
  prepareEffect: PrepareEffectConfig | undefined,
  catalog: CommandCatalog,
): void {
  if (!prepareEffect) return;
  const prepare = catalog.byAlias[prepareEffect.prepareCommand.toLowerCase()];
  if (!prepare) throw new Error(`Scheduled check ${name} references unknown prepare command.`);
  const effect = catalog.byAlias[prepareEffect.effectCommand.toLowerCase()];
  if (!effect) throw new Error(`Scheduled check ${name} references unknown effect command.`);
}

function scheduledCheckFromRow(row: ScheduledJobRow, catalog: CommandCatalog): ScheduledCheck {
  const command = catalog.byAlias[row.command_name.toLowerCase()];
  if (!command) throw new Error(`Scheduled check ${row.name} references unknown command: ${row.command_name}`);
  if (!row.cron_expr) throw new Error(`Scheduled check ${row.name} has no cron expression stored.`);
  return {
    id: row.name,
    name: row.name,
    source: row.source === "runtime" ? "runtime" : "config",
    label: row.label,
    cron: row.cron_expr,
    timezone: row.timezone || loadAgentConfig().runtime?.timezone || "UTC",
    enabled: row.enabled === 1,
    delivery: row.delivery === "silent" ? "silent" : "telegram",
    notifyOnChangeOnly: row.notify_on_change_only === 1,
    prepareEffect: parsePrepareEffect(row.prepare_effect_json),
    command,
  };
}

function safeScheduledCheckFromRow(row: ScheduledJobRow, catalog: CommandCatalog): ScheduledCheck | null {
  try {
    return scheduledCheckFromRow(row, catalog);
  } catch (error) {
    log.warn("scheduler", "schedule.skipped", {
      name: row.name,
      commandName: row.command_name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function formatScheduleList(checks: ScheduledCheck[] = loadScheduledChecks()): string {
  if (!checks.length) return "No scheduled checks configured.";
  return checks
    .map((check) => {
      const state = check.enabled ? "enabled" : "disabled";
      const delivery = check.delivery === "silent" ? "silent" : "telegram";
      const changeOnly = check.notifyOnChangeOnly ? ", change-only" : "";
      return `${check.name} - ${check.label} [${state}, cron: ${check.cron}, ${delivery}${changeOnly}]`;
    })
    .join("\n");
}

export function formatScheduleDetails(name: string): string {
  const row = getScheduledJob(name);
  if (!row) return `Scheduled check not found: ${name}`;
  return [
    `${row.name} - ${row.label}`,
    `state: ${row.enabled ? "enabled" : "disabled"}`,
    `command: ${row.command_name}`,
    `cron: ${row.cron_expr || "(none)"}`,
    `delivery: ${row.delivery}`,
    `change-only: ${row.notify_on_change_only ? "yes" : "no"}`,
    `version: ${row.version}`,
    `next: ${row.next_run_at || "-"}`,
    `last: ${row.last_run_at || "-"}`,
    `last status: ${row.last_status || "-"}`,
    `last traceId: ${row.last_trace_id || "-"}`,
    `lease: ${row.lease_owner && row.lease_until ? `${row.lease_owner} until ${row.lease_until}` : "-"}`,
  ].join("\n");
}

export function formatScheduleHistory(name: string, limit = 5): string {
  const runs = listScheduledRuns(name, limit);
  if (!runs.length) return `No scheduled runs recorded for ${name}.`;
  return runs.map(formatRunRow).join("\n\n");
}

function formatRunRow(run: ScheduledRunRow): string {
  return [
    `${run.status.toUpperCase()} ${run.job_name}`,
    `traceId: ${run.trace_id}`,
    `finished: ${run.finished_at}`,
    `exit: ${run.exit_code}`,
    `notified: ${run.notification_sent ? "yes" : "no"}`,
    run.output_tail || "(no output)",
  ].join("\n");
}

export function findScheduledCheck(name: string, checks = loadScheduledChecks()): ScheduledCheck | null {
  return checks.find((check) => check.name === name) || null;
}

export function nextRunAtFor(
  check: ScheduledCheck,
  from = new Date(),
  timeZone = check.timezone || loadAgentConfig().runtime?.timezone || "UTC",
): string | null {
  if (!check.enabled) return null;
  return nextAfter(check.cron, from, timeZone);
}


export async function runScheduledCheck(input: {
  check: ScheduledCheck;
  /** The configured owner that may approve a newly-discovered scheduled effect. */
  principalId: string;
  chatId: string;
  defaultTimeoutMs?: number;
  notify?: SchedulerNotifier;
  forceNotify?: boolean;
  leaseOwner?: string;
  runtime?: AgentRuntime;
}): Promise<ScheduledCheckResult> {
  if (!getScheduledJob(input.check.name)) {
    upsertScheduledJob({
      name: input.check.name,
      source: input.check.source,
      label: input.check.label,
      commandName: input.check.command.name || input.check.command.label,
      cronExpr: input.check.cron,
      timezone: input.check.timezone,
      enabled: input.check.enabled,
      delivery: input.check.delivery,
      notifyOnChangeOnly: input.check.notifyOnChangeOnly,
      prepareEffect: input.check.prepareEffect,
      nextRunAt: nextRunAtFor(input.check),
    });
  }
  const traceId = generateTraceId();
  const startedAt = nowIso();
  log.info(traceId, "schedule.started", {
    name: input.check.name,
    commandName: input.check.command.name,
  });

  return (input.runtime || schedulerRuntime).executeScheduled({
    runId: traceId,
    scheduleId: input.check.id,
    principalId: input.principalId,
    chatId: input.chatId,
    userRequest: `Run configured schedule ${input.check.name}: ${input.check.label}.`,
    defaultTimeoutMs: input.defaultTimeoutMs,
  }, async (tools) => {
    let output = "";
    let exitCode = 1;
    let status: "success" | "failed" = "failed";
    try {
    const result = await tools.runCommand(input.check.command);
    const data = result.data as { output?: string; exitCode?: number; signal?: string } | undefined;
    output = data?.output || result.summary;
    exitCode = data?.exitCode ?? (result.ok ? 0 : 1);
    status = result.ok && !data?.signal ? "success" : "failed";
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }

    if (status === "success" && input.check.prepareEffect) {
      const effect = await runConfiguredEffect(input.check, tools);
      output = `${output}\n\n${effect.output}`.trim();
      if (!effect.ok) {
        status = "failed";
        exitCode = effect.exitCode;
      }
    }

    const outputTail = tailLines(output, 20).slice(-2000);
    const outputDigest = hashOutput(output);
    const finishedAt = nowIso();
    const previous = getScheduledJob(input.check.name);
    const unchanged = previous?.last_output_digest === outputDigest;
    const shouldNotify =
      input.check.delivery === "telegram" &&
      input.notify !== undefined &&
      (input.forceNotify || status === "failed" || !input.check.notifyOnChangeOnly || !unchanged);
    let notificationSent = false;
    const notification = formatScheduledCheckResult({
      name: input.check.name,
      label: input.check.label,
      traceId,
      status,
      exitCode,
      outputTail: summarizeOutput(output, outputTail),
      outputDigest,
      notificationSent: false,
      finishedAt,
    });

    if (shouldNotify) {
      await input.notify!(notification);
      notificationSent = true;
    }

    const scheduledResult: ScheduledCheckResult = {
      name: input.check.name,
      label: input.check.label,
      traceId,
      status,
      exitCode,
      outputTail,
      outputDigest,
      notificationSent,
      finishedAt,
    };
    const nextRunAt = nextRunAtFor(input.check);
    recordScheduledRun({
      jobName: input.check.name,
      leaseOwner: input.leaseOwner,
      traceId,
      status,
      exitCode,
      outputTail,
      outputDigest,
      notificationSent,
      startedAt,
      finishedAt,
      nextRunAt,
    });
    setJsonState("runtime_state", "lastScheduledRun", scheduledResult);
    log.info(traceId, status === "success" ? "schedule.completed" : "schedule.failed", scheduledResult);
    return scheduledResult;
  });
}

async function runConfiguredEffect(
  check: ScheduledCheck,
  tools: ScheduledToolContext,
): Promise<{ ok: boolean; exitCode: number; output: string }> {
  if (!check.prepareEffect) return { ok: true, exitCode: 0, output: "" };
  const catalog = loadCommandCatalog();
  const prepare = catalog.byAlias[check.prepareEffect.prepareCommand.toLowerCase()];
  const effect = catalog.byAlias[check.prepareEffect.effectCommand.toLowerCase()];
  if (!prepare || !effect) return { ok: false, exitCode: 1, output: "Configured schedule effect is unavailable." };
  const preparedAction = withCommandInput(prepare, check.prepareEffect.prepareInput ?? {});
  const result = await tools.runCommand(preparedAction);
  const commandData = result.data as { output?: string; exitCode?: number } | undefined;
  if (!result.ok || commandData?.exitCode !== 0) {
    return { ok: false, exitCode: commandData?.exitCode ?? 1, output: `Scheduled prepare step failed for ${check.prepareEffect.effectCommand}: ${commandData?.output || result.summary}` };
  }

  let effectInput: unknown;
  try { effectInput = JSON.parse(commandData?.output || ""); } catch {
    return { ok: false, exitCode: 1, output: `Scheduled prepare step returned invalid JSON for ${check.prepareEffect.effectCommand}.` };
  }
  const effectAction = withCommandInput(effect, effectInput);
  const effectResult = await tools.runCommand(effectAction);
  const effectData = effectResult.data as { output?: string; exitCode?: number } | undefined;
  return {
    ok: effectResult.ok && effectData?.exitCode === 0,
    exitCode: effectData?.exitCode ?? (effectResult.ok ? 0 : 1),
    output: `Scheduled effect ${effectAction.label}: ${effectData?.output || effectResult.summary}`,
  };
}

function summarizeOutput(output: string, fallback: string): string {
  try {
    const parsed = JSON.parse(output) as { count?: unknown; records?: Array<{ date?: string; lateMinutes?: number }> };
    if (typeof parsed.count === "number" && Array.isArray(parsed.records)) {
      const dates = parsed.records
        .map((record) => `${record.date}${record.lateMinutes === undefined ? "" : ` (${record.lateMinutes}m)`}`)
        .join(", ");
      return `count: ${parsed.count}\n${dates || "(no records)"}`;
    }
  } catch {
    // Keep fallback for non-JSON command output.
  }
  return fallback;
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

export function scheduleUpdatePreview(input: {
  action: "enable" | "disable" | "cron" | "delivery";
  name: string;
  value?: string;
  expectedVersion?: number;
}): { digest: string; preview: string } {
  const preview = JSON.stringify(input);
  return {
    preview,
    digest: crypto.createHash("sha256").update(preview).digest("hex"),
  };
}

export function applyScheduleUpdate(input: {
  action: "enable" | "disable" | "cron" | "delivery";
  name: string;
  value?: string;
  expectedVersion?: number;
}): string {
  const row = getScheduledJob(input.name);
  if (!row) return `Scheduled check not found: ${input.name}`;
  try {
    if (input.action === "enable") {
      const check = safeScheduledCheckFromRow(row, loadCommandCatalog());
      updateScheduledJobState({
        name: input.name,
        enabled: true,
        expectedVersion: input.expectedVersion,
        nextRunAt: check ? nextRunAtFor({ ...check, enabled: true }) : null,
      });
      return `Enabled ${input.name}.`;
    }
    if (input.action === "disable") {
      updateScheduledJobState({
        name: input.name,
        enabled: false,
        expectedVersion: input.expectedVersion,
        nextRunAt: null,
      });
      return `Disabled ${input.name}.`;
    }
    if (input.action === "cron") {
      const expr = String(input.value);
      const cronError = validateCron(expr);
      if (cronError) return `Invalid cron expression: ${cronError}`;
      const timeZone = row.timezone || loadAgentConfig().runtime?.timezone || "UTC";
      const nextRunAt = row.enabled ? nextAfter(expr, new Date(), timeZone) : null;
      updateScheduledJobState({
        name: input.name,
        cronExpr: expr,
        expectedVersion: input.expectedVersion,
        nextRunAt,
      });
      return `Updated ${input.name} cron to: ${expr}`;
    }
    if (input.action === "delivery") {
      const delivery = String(input.value);
      if (delivery !== "telegram" && delivery !== "silent") return "Delivery must be telegram or silent.";
      updateScheduledJobState({ name: input.name, delivery, expectedVersion: input.expectedVersion });
      return `Updated ${input.name} delivery to ${delivery}.`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "Unsupported schedule update.";
}

export class ScheduledCheckRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly runnerId = `scheduler-${process.pid}-${Math.random().toString(16).slice(2)}`;

  constructor(
    private readonly principalId: string,
    private readonly chatId: string,
    private readonly notify: SchedulerNotifier,
    private readonly defaultTimeoutMs?: number,
    private readonly tickMs = DEFAULT_TICK_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const catalog = loadCommandCatalog();
      for (const row of listDueScheduledJobs()) {
        const leaseOwner = `${this.runnerId}-${row.name}-${Date.now()}`;
        const claimed = claimDueScheduledJob({
          name: row.name,
          leaseOwner,
          leaseUntil: new Date(Date.now() + (this.defaultTimeoutMs || 10 * 60 * 1000) + 60_000).toISOString(),
        });
        if (!claimed) continue;
        const check = safeScheduledCheckFromRow(claimed, catalog);
        if (!check) continue;
        await this.runAndNotify(check, false, leaseOwner);
      }
    } finally {
      this.running = false;
    }
  }

  async runAndNotify(
    check: ScheduledCheck,
    forceNotify = true,
    leaseOwner?: string,
  ): Promise<ScheduledCheckResult> {
    return runScheduledCheck({
      check,
      principalId: this.principalId,
      chatId: this.chatId,
      defaultTimeoutMs: this.defaultTimeoutMs,
      notify: this.notify,
      forceNotify,
      leaseOwner,
    });
  }
}
