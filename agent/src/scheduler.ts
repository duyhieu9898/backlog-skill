import crypto from "node:crypto";

import { loadAgentConfig, type ScheduledCheckConfig } from "./config/app";
import {
  commandPreviewDigest,
  loadCommandCatalog,
  previewCommand,
  runTrackedCommand,
  withCommandInput,
  type AgentCommand,
  type CommandCatalog,
} from "./commands";
import { generateTraceId } from "./logging/trace";
import { log } from "./logging/logger";
import {
  claimDueScheduledJob,
  getScheduledJob,
  listDueScheduledJobs,
  listScheduledJobs,
  listScheduledRuns,
  nowIso,
  recordScheduledRun,
  setJsonState,
  updateScheduledJobState,
  upsertPendingConfirmation,
  upsertScheduledJob,
  type ScheduledJobRow,
  type ScheduledRunRow,
} from "./storage/repositories";
import { tailLines } from "./utils";

export type ScheduledCheck = {
  name: string;
  label: string;
  intervalMinutes: number;
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

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

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
  for (const config of configs) {
    const check = normalizeScheduledCheck(config, catalog);
    upsertScheduledJob({
      name: check.name,
      label: check.label,
      commandName: check.command.name || check.command.label,
      intervalMinutes: check.intervalMinutes,
      enabled: check.enabled,
      delivery: check.delivery,
      notifyOnChangeOnly: check.notifyOnChangeOnly,
      prepareEffect: check.prepareEffect,
      nextRunAt: check.enabled ? addMinutes(new Date(), check.intervalMinutes).toISOString() : null,
    });
  }
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
  if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 1) {
    throw new Error(`Scheduled check ${name} must use intervalMinutes >= 1.`);
  }
  const command = catalog.byAlias[config.command.toLowerCase()];
  if (!command) throw new Error(`Scheduled check ${name} references unknown command: ${config.command}`);
  if (command.requiresConfirmation || command.externalSideEffect) {
    throw new Error(`Scheduled check ${name} must reference a read-only command.`);
  }
  validatePrepareEffect(name, config.prepareEffect, catalog);

  return {
    name,
    label: config.label?.trim() || command.label,
    intervalMinutes: config.intervalMinutes,
    enabled: config.enabled === true,
    delivery: config.delivery || "telegram",
    notifyOnChangeOnly: config.notifyOnChangeOnly === true,
    prepareEffect: config.prepareEffect,
    command,
  };
}

function validatePrepareEffect(
  name: string,
  prepareEffect: PrepareEffectConfig | undefined,
  catalog: CommandCatalog,
): void {
  if (!prepareEffect) return;
  const prepare = catalog.byAlias[prepareEffect.prepareCommand.toLowerCase()];
  if (!prepare) throw new Error(`Scheduled check ${name} references unknown prepare command.`);
  if (prepare.requiresConfirmation || prepare.externalSideEffect) {
    throw new Error(`Scheduled check ${name} prepare command must be read-only.`);
  }
  const effect = catalog.byAlias[prepareEffect.effectCommand.toLowerCase()];
  if (!effect) throw new Error(`Scheduled check ${name} references unknown effect command.`);
  if (!effect.requiresConfirmation && !effect.externalSideEffect) {
    throw new Error(`Scheduled check ${name} effect command must require confirmation.`);
  }
}

function scheduledCheckFromRow(row: ScheduledJobRow, catalog: CommandCatalog): ScheduledCheck {
  const command = catalog.byAlias[row.command_name.toLowerCase()];
  if (!command) throw new Error(`Scheduled check ${row.name} references unknown command: ${row.command_name}`);
  return {
    name: row.name,
    label: row.label,
    intervalMinutes: row.interval_minutes,
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
      return `${check.name} - ${check.label} [${state}, every ${check.intervalMinutes}m, ${delivery}${changeOnly}]`;
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
    `interval: ${row.interval_minutes}m`,
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

export function nextRunAtFor(check: ScheduledCheck, from = new Date()): string | null {
  return check.enabled ? addMinutes(from, check.intervalMinutes).toISOString() : null;
}

export async function runScheduledCheck(input: {
  check: ScheduledCheck;
  chatId: string;
  defaultTimeoutMs?: number;
  notify?: SchedulerNotifier;
  forceNotify?: boolean;
  leaseOwner?: string;
}): Promise<ScheduledCheckResult> {
  if (!getScheduledJob(input.check.name)) {
    upsertScheduledJob({
      name: input.check.name,
      label: input.check.label,
      commandName: input.check.command.name || input.check.command.label,
      intervalMinutes: input.check.intervalMinutes,
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

  let output = "";
  let exitCode = 1;
  let status: "success" | "failed" = "failed";
  try {
    const result = await runTrackedCommand({
      traceId,
      chatId: input.chatId,
      action: input.check.command,
      defaultTimeoutMs: input.defaultTimeoutMs,
    });
    output = result.output;
    exitCode = result.exitCode;
    status = result.exitCode === 0 && !result.signal ? "success" : "failed";
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
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
  let notification = formatScheduledCheckResult({
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

  if (status === "success" && input.check.prepareEffect && shouldNotify) {
    const preview = await buildEffectPreview(input.check, traceId, input.chatId, input.defaultTimeoutMs);
    if (preview) notification = `${notification}\n\n${preview}`;
  }

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
}

async function buildEffectPreview(
  check: ScheduledCheck,
  traceId: string,
  chatId: string,
  defaultTimeoutMs?: number,
): Promise<string | null> {
  if (!check.prepareEffect) return null;
  const catalog = loadCommandCatalog();
  const prepare = catalog.byAlias[check.prepareEffect.prepareCommand.toLowerCase()];
  const effect = catalog.byAlias[check.prepareEffect.effectCommand.toLowerCase()];
  if (!prepare || !effect) return null;
  const preparedAction = withCommandInput(prepare, check.prepareEffect.prepareInput ?? {});
  const result = await runTrackedCommand({
    traceId,
    chatId,
    action: preparedAction,
    defaultTimeoutMs,
  });
  if (result.exitCode !== 0) return `Effect preview failed for ${check.prepareEffect.effectCommand}.`;

  const effectInput = JSON.parse(result.output);
  const effectAction = withCommandInput(effect, effectInput);
  const preview = previewCommand(effectAction, defaultTimeoutMs);
  const digest = commandPreviewDigest(preview);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  upsertPendingConfirmation({
    chatId,
    traceId,
    commandName: effectAction.name || effectAction.label,
    payload: { action: effectAction, preview, digest },
    expiresAt,
  });
  return [
    `Prepared follow-up preview: ${effectAction.label}`,
    `createDates: ${JSON.stringify(effectInput.createDates || [])}`,
    `skippedDates: ${JSON.stringify(effectInput.skippedDates || [])}`,
    `Approval: ${digest.slice(0, 12)}`,
    `Gõ: confirm ${effectAction.name || effectAction.label} ${digest.slice(0, 12)}`,
  ].join("\n");
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
  action: "enable" | "disable" | "interval" | "delivery";
  name: string;
  value?: string | number;
  expectedVersion?: number;
}): { digest: string; preview: string } {
  const preview = JSON.stringify(input);
  return {
    preview,
    digest: crypto.createHash("sha256").update(preview).digest("hex"),
  };
}

export function applyScheduleUpdate(input: {
  action: "enable" | "disable" | "interval" | "delivery";
  name: string;
  value?: string | number;
  expectedVersion?: number;
}): string {
  const row = getScheduledJob(input.name);
  if (!row) return `Scheduled check not found: ${input.name}`;
  try {
    if (input.action === "enable") {
      updateScheduledJobState({
        name: input.name,
        enabled: true,
        expectedVersion: input.expectedVersion,
        nextRunAt: addMinutes(new Date(), row.interval_minutes).toISOString(),
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
    if (input.action === "interval") {
      const minutes = Number(input.value);
      if (!Number.isFinite(minutes) || minutes < 1) return "Interval must be at least 1 minute.";
      updateScheduledJobState({
        name: input.name,
        intervalMinutes: minutes,
        expectedVersion: input.expectedVersion,
        nextRunAt: row.enabled ? addMinutes(new Date(), minutes).toISOString() : null,
      });
      return `Updated ${input.name} interval to ${minutes}m.`;
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
      chatId: this.chatId,
      defaultTimeoutMs: this.defaultTimeoutMs,
      notify: this.notify,
      forceNotify,
      leaseOwner,
    });
  }
}
