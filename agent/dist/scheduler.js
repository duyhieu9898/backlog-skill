"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScheduledCheckRunner = void 0;
exports.seedScheduledJobsFromConfig = seedScheduledJobsFromConfig;
exports.loadScheduledChecks = loadScheduledChecks;
exports.normalizeScheduledCheck = normalizeScheduledCheck;
exports.formatScheduleList = formatScheduleList;
exports.formatScheduleDetails = formatScheduleDetails;
exports.formatScheduleHistory = formatScheduleHistory;
exports.findScheduledCheck = findScheduledCheck;
exports.nextRunAtFor = nextRunAtFor;
exports.runScheduledCheck = runScheduledCheck;
exports.formatScheduledCheckResult = formatScheduledCheckResult;
exports.scheduleUpdatePreview = scheduleUpdatePreview;
exports.applyScheduleUpdate = applyScheduleUpdate;
const node_crypto_1 = __importDefault(require("node:crypto"));
const app_1 = require("./config/app");
const commands_1 = require("./commands");
const trace_1 = require("./logging/trace");
const logger_1 = require("./logging/logger");
const repositories_1 = require("./storage/repositories");
const utils_1 = require("./utils");
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_TICK_MS = 30_000;
let configSeeded = false;
function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60 * 1000);
}
function hashOutput(value) {
    return node_crypto_1.default.createHash("sha256").update(value).digest("hex");
}
function parsePrepareEffect(value) {
    if (!value)
        return undefined;
    return JSON.parse(value);
}
function seedScheduledJobsFromConfig(configs = (0, app_1.loadAgentConfig)().schedules || [], catalog = (0, commands_1.loadCommandCatalog)()) {
    for (const config of configs) {
        const check = normalizeScheduledCheck(config, catalog);
        (0, repositories_1.upsertScheduledJob)({
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
function ensureScheduledJobsSeeded(configs = (0, app_1.loadAgentConfig)().schedules || [], catalog = (0, commands_1.loadCommandCatalog)()) {
    if (configSeeded)
        return;
    seedScheduledJobsFromConfig(configs, catalog);
    configSeeded = true;
}
function loadScheduledChecks(configs, catalog = (0, commands_1.loadCommandCatalog)()) {
    if (configs) {
        seedScheduledJobsFromConfig(configs, catalog);
    }
    else {
        ensureScheduledJobsSeeded((0, app_1.loadAgentConfig)().schedules || [], catalog);
    }
    return (0, repositories_1.listScheduledJobs)().flatMap((row) => {
        const check = safeScheduledCheckFromRow(row, catalog);
        return check ? [check] : [];
    });
}
function normalizeScheduledCheck(config, catalog) {
    const name = config.name?.trim();
    if (!name || !NAME_PATTERN.test(name)) {
        throw new Error(`Scheduled check has invalid name: ${config.name || "(empty)"}`);
    }
    if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 1) {
        throw new Error(`Scheduled check ${name} must use intervalMinutes >= 1.`);
    }
    const command = catalog.byAlias[config.command.toLowerCase()];
    if (!command)
        throw new Error(`Scheduled check ${name} references unknown command: ${config.command}`);
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
function validatePrepareEffect(name, prepareEffect, catalog) {
    if (!prepareEffect)
        return;
    const prepare = catalog.byAlias[prepareEffect.prepareCommand.toLowerCase()];
    if (!prepare)
        throw new Error(`Scheduled check ${name} references unknown prepare command.`);
    if (prepare.requiresConfirmation || prepare.externalSideEffect) {
        throw new Error(`Scheduled check ${name} prepare command must be read-only.`);
    }
    const effect = catalog.byAlias[prepareEffect.effectCommand.toLowerCase()];
    if (!effect)
        throw new Error(`Scheduled check ${name} references unknown effect command.`);
    if (!effect.requiresConfirmation && !effect.externalSideEffect) {
        throw new Error(`Scheduled check ${name} effect command must require confirmation.`);
    }
}
function scheduledCheckFromRow(row, catalog) {
    const command = catalog.byAlias[row.command_name.toLowerCase()];
    if (!command)
        throw new Error(`Scheduled check ${row.name} references unknown command: ${row.command_name}`);
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
function safeScheduledCheckFromRow(row, catalog) {
    try {
        return scheduledCheckFromRow(row, catalog);
    }
    catch (error) {
        logger_1.log.warn("scheduler", "schedule.skipped", {
            name: row.name,
            commandName: row.command_name,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}
function formatScheduleList(checks = loadScheduledChecks()) {
    if (!checks.length)
        return "No scheduled checks configured.";
    return checks
        .map((check) => {
        const state = check.enabled ? "enabled" : "disabled";
        const delivery = check.delivery === "silent" ? "silent" : "telegram";
        const changeOnly = check.notifyOnChangeOnly ? ", change-only" : "";
        return `${check.name} - ${check.label} [${state}, every ${check.intervalMinutes}m, ${delivery}${changeOnly}]`;
    })
        .join("\n");
}
function formatScheduleDetails(name) {
    const row = (0, repositories_1.getScheduledJob)(name);
    if (!row)
        return `Scheduled check not found: ${name}`;
    return [
        `${row.name} - ${row.label}`,
        `state: ${row.enabled ? "enabled" : "disabled"}`,
        `command: ${row.command_name}`,
        `interval: ${row.interval_minutes}m`,
        `delivery: ${row.delivery}`,
        `change-only: ${row.notify_on_change_only ? "yes" : "no"}`,
        `next: ${row.next_run_at || "-"}`,
        `last: ${row.last_run_at || "-"}`,
        `last status: ${row.last_status || "-"}`,
        `last traceId: ${row.last_trace_id || "-"}`,
    ].join("\n");
}
function formatScheduleHistory(name, limit = 5) {
    const runs = (0, repositories_1.listScheduledRuns)(name, limit);
    if (!runs.length)
        return `No scheduled runs recorded for ${name}.`;
    return runs.map(formatRunRow).join("\n\n");
}
function formatRunRow(run) {
    return [
        `${run.status.toUpperCase()} ${run.job_name}`,
        `traceId: ${run.trace_id}`,
        `finished: ${run.finished_at}`,
        `exit: ${run.exit_code}`,
        `notified: ${run.notification_sent ? "yes" : "no"}`,
        run.output_tail || "(no output)",
    ].join("\n");
}
function findScheduledCheck(name, checks = loadScheduledChecks()) {
    return checks.find((check) => check.name === name) || null;
}
function nextRunAtFor(check, from = new Date()) {
    return check.enabled ? addMinutes(from, check.intervalMinutes).toISOString() : null;
}
async function runScheduledCheck(input) {
    if (!(0, repositories_1.getScheduledJob)(input.check.name)) {
        (0, repositories_1.upsertScheduledJob)({
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
    const traceId = (0, trace_1.generateTraceId)();
    const startedAt = (0, repositories_1.nowIso)();
    logger_1.log.info(traceId, "schedule.started", {
        name: input.check.name,
        commandName: input.check.command.name,
    });
    let output = "";
    let exitCode = 1;
    let status = "failed";
    try {
        const result = await (0, commands_1.runTrackedCommand)({
            traceId,
            chatId: input.chatId,
            action: input.check.command,
            defaultTimeoutMs: input.defaultTimeoutMs,
        });
        output = result.output;
        exitCode = result.exitCode;
        status = result.exitCode === 0 && !result.signal ? "success" : "failed";
    }
    catch (error) {
        output = error instanceof Error ? error.message : String(error);
    }
    const outputTail = (0, utils_1.tailLines)(output, 20).slice(-2000);
    const outputDigest = hashOutput(output);
    const finishedAt = (0, repositories_1.nowIso)();
    const previous = (0, repositories_1.getScheduledJob)(input.check.name);
    const unchanged = previous?.last_output_digest === outputDigest;
    const shouldNotify = input.check.delivery === "telegram" &&
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
        if (preview)
            notification = `${notification}\n\n${preview}`;
    }
    if (shouldNotify) {
        await input.notify(notification);
        notificationSent = true;
    }
    const scheduledResult = {
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
    (0, repositories_1.recordScheduledRun)({
        jobName: input.check.name,
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
    (0, repositories_1.setJsonState)("runtime_state", "lastScheduledRun", scheduledResult);
    logger_1.log.info(traceId, status === "success" ? "schedule.completed" : "schedule.failed", scheduledResult);
    return scheduledResult;
}
async function buildEffectPreview(check, traceId, chatId, defaultTimeoutMs) {
    if (!check.prepareEffect)
        return null;
    const catalog = (0, commands_1.loadCommandCatalog)();
    const prepare = catalog.byAlias[check.prepareEffect.prepareCommand.toLowerCase()];
    const effect = catalog.byAlias[check.prepareEffect.effectCommand.toLowerCase()];
    if (!prepare || !effect)
        return null;
    const preparedAction = (0, commands_1.withCommandInput)(prepare, check.prepareEffect.prepareInput ?? {});
    const result = await (0, commands_1.runTrackedCommand)({
        traceId,
        chatId,
        action: preparedAction,
        defaultTimeoutMs,
    });
    if (result.exitCode !== 0)
        return `Effect preview failed for ${check.prepareEffect.effectCommand}.`;
    const effectInput = JSON.parse(result.output);
    const effectAction = (0, commands_1.withCommandInput)(effect, effectInput);
    const preview = (0, commands_1.previewCommand)(effectAction, defaultTimeoutMs);
    const digest = (0, commands_1.commandPreviewDigest)(preview);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    (0, repositories_1.upsertPendingConfirmation)({
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
function summarizeOutput(output, fallback) {
    try {
        const parsed = JSON.parse(output);
        if (typeof parsed.count === "number" && Array.isArray(parsed.records)) {
            const dates = parsed.records
                .map((record) => `${record.date}${record.lateMinutes === undefined ? "" : ` (${record.lateMinutes}m)`}`)
                .join(", ");
            return `count: ${parsed.count}\n${dates || "(no records)"}`;
        }
    }
    catch {
        // Keep fallback for non-JSON command output.
    }
    return fallback;
}
function formatScheduledCheckResult(result) {
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
function scheduleUpdatePreview(input) {
    const preview = JSON.stringify(input);
    return {
        preview,
        digest: node_crypto_1.default.createHash("sha256").update(preview).digest("hex"),
    };
}
function applyScheduleUpdate(input) {
    const row = (0, repositories_1.getScheduledJob)(input.name);
    if (!row)
        return `Scheduled check not found: ${input.name}`;
    if (input.action === "enable") {
        (0, repositories_1.updateScheduledJobState)({
            name: input.name,
            enabled: true,
            nextRunAt: addMinutes(new Date(), row.interval_minutes).toISOString(),
        });
        return `Enabled ${input.name}.`;
    }
    if (input.action === "disable") {
        (0, repositories_1.updateScheduledJobState)({ name: input.name, enabled: false, nextRunAt: null });
        return `Disabled ${input.name}.`;
    }
    if (input.action === "interval") {
        const minutes = Number(input.value);
        if (!Number.isFinite(minutes) || minutes < 1)
            return "Interval must be at least 1 minute.";
        (0, repositories_1.updateScheduledJobState)({
            name: input.name,
            intervalMinutes: minutes,
            nextRunAt: row.enabled ? addMinutes(new Date(), minutes).toISOString() : null,
        });
        return `Updated ${input.name} interval to ${minutes}m.`;
    }
    if (input.action === "delivery") {
        const delivery = String(input.value);
        if (delivery !== "telegram" && delivery !== "silent")
            return "Delivery must be telegram or silent.";
        (0, repositories_1.updateScheduledJobState)({ name: input.name, delivery });
        return `Updated ${input.name} delivery to ${delivery}.`;
    }
    return "Unsupported schedule update.";
}
class ScheduledCheckRunner {
    chatId;
    notify;
    defaultTimeoutMs;
    tickMs;
    timer = null;
    running = false;
    constructor(chatId, notify, defaultTimeoutMs, tickMs = DEFAULT_TICK_MS) {
        this.chatId = chatId;
        this.notify = notify;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.tickMs = tickMs;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.tick();
        }, this.tickMs);
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    async tick() {
        if (this.running)
            return;
        this.running = true;
        try {
            const catalog = (0, commands_1.loadCommandCatalog)();
            for (const row of (0, repositories_1.listDueScheduledJobs)()) {
                const check = safeScheduledCheckFromRow(row, catalog);
                if (!check)
                    continue;
                await this.runAndNotify(check, false);
            }
        }
        finally {
            this.running = false;
        }
    }
    async runAndNotify(check, forceNotify = true) {
        return runScheduledCheck({
            check,
            chatId: this.chatId,
            defaultTimeoutMs: this.defaultTimeoutMs,
            notify: this.notify,
            forceNotify,
        });
    }
}
exports.ScheduledCheckRunner = ScheduledCheckRunner;
