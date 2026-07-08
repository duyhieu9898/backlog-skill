"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScheduledCheckRunner = void 0;
exports.loadScheduledChecks = loadScheduledChecks;
exports.normalizeScheduledCheck = normalizeScheduledCheck;
exports.formatScheduleList = formatScheduleList;
exports.findScheduledCheck = findScheduledCheck;
exports.runScheduledCheck = runScheduledCheck;
exports.formatScheduledCheckResult = formatScheduledCheckResult;
const app_1 = require("./config/app");
const commands_1 = require("./commands");
const trace_1 = require("./logging/trace");
const logger_1 = require("./logging/logger");
const repositories_1 = require("./storage/repositories");
const utils_1 = require("./utils");
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
function loadScheduledChecks(configs = (0, app_1.loadAgentConfig)().schedules || [], catalog = (0, commands_1.loadCommandCatalog)()) {
    return configs.map((config) => normalizeScheduledCheck(config, catalog));
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
    return {
        name,
        label: config.label?.trim() || command.label,
        intervalMinutes: config.intervalMinutes,
        enabled: config.enabled === true,
        command,
    };
}
function formatScheduleList(checks) {
    if (!checks.length)
        return "No scheduled checks configured.";
    return checks
        .map((check) => {
        const state = check.enabled ? "enabled" : "disabled";
        return `${check.name} - ${check.label} [${state}, every ${check.intervalMinutes}m]`;
    })
        .join("\n");
}
function findScheduledCheck(name, checks = loadScheduledChecks()) {
    return checks.find((check) => check.name === name) || null;
}
async function runScheduledCheck(input) {
    const traceId = (0, trace_1.generateTraceId)();
    logger_1.log.info(traceId, "schedule.started", {
        name: input.check.name,
        commandName: input.check.command.name,
    });
    try {
        const result = await (0, commands_1.runTrackedCommand)({
            traceId,
            chatId: input.chatId,
            action: input.check.command,
            defaultTimeoutMs: input.defaultTimeoutMs,
        });
        const ok = result.exitCode === 0 && !result.signal;
        const finishedAt = (0, repositories_1.nowIso)();
        const scheduledResult = {
            name: input.check.name,
            label: input.check.label,
            traceId,
            status: ok ? "success" : "failed",
            exitCode: result.exitCode,
            outputTail: (0, utils_1.tailLines)(result.output, 20).slice(-2000),
            finishedAt,
        };
        (0, repositories_1.setJsonState)("runtime_state", "lastScheduledRun", scheduledResult);
        logger_1.log.info(traceId, ok ? "schedule.completed" : "schedule.failed", scheduledResult);
        return scheduledResult;
    }
    catch (error) {
        const finishedAt = (0, repositories_1.nowIso)();
        const scheduledResult = {
            name: input.check.name,
            label: input.check.label,
            traceId,
            status: "failed",
            exitCode: 1,
            outputTail: error instanceof Error ? error.message : String(error),
            finishedAt,
        };
        (0, repositories_1.setJsonState)("runtime_state", "lastScheduledRun", scheduledResult);
        logger_1.log.error(traceId, "schedule.failed", { error });
        return scheduledResult;
    }
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
class ScheduledCheckRunner {
    checks;
    chatId;
    notify;
    defaultTimeoutMs;
    timers = [];
    constructor(checks, chatId, notify, defaultTimeoutMs) {
        this.checks = checks;
        this.chatId = chatId;
        this.notify = notify;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    start() {
        for (const check of this.checks) {
            if (!check.enabled)
                continue;
            const timer = setInterval(() => {
                void this.runAndNotify(check);
            }, check.intervalMinutes * 60 * 1000);
            this.timers.push(timer);
        }
    }
    stop() {
        while (this.timers.length) {
            const timer = this.timers.pop();
            if (timer)
                clearInterval(timer);
        }
    }
    async runAndNotify(check) {
        const result = await runScheduledCheck({
            check,
            chatId: this.chatId,
            defaultTimeoutMs: this.defaultTimeoutMs,
        });
        await this.notify(formatScheduledCheckResult(result));
        return result;
    }
}
exports.ScheduledCheckRunner = ScheduledCheckRunner;
