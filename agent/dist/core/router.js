"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = void 0;
const app_1 = require("../config/app");
const commands_1 = require("../commands");
const logger_1 = require("../logging/logger");
const repositories_1 = require("../storage/repositories");
const loop_1 = require("../tools/loop");
const approvalService_1 = require("../security/approvalService");
const agentRuntime_1 = require("../runtime/agentRuntime");
const debugCommands_1 = require("./debugCommands");
const presenter_1 = require("./presenter");
const scheduler_1 = require("../scheduler");
class Router {
    registry;
    toolLoop;
    commandTimeoutMs;
    chatLocks = new Map();
    approvals = new approvalService_1.ApprovalService();
    runtime;
    constructor(registry, toolLoop = new loop_1.AgentToolLoop()) {
        this.registry = registry;
        this.toolLoop = toolLoop;
        this.runtime = new agentRuntime_1.AgentRuntime(registry, this.toolLoop);
        this.commandTimeoutMs = (0, app_1.loadAgentConfig)().runtime?.commandTimeoutMs || 10 * 60 * 1000;
    }
    async route(message, onReplyMarkup, onArtifact) {
        // A stop must not wait behind the command it is meant to interrupt.
        if (message.text.trim().toLowerCase() === "/stop") {
            return this.routeSerialized(message, onReplyMarkup, onArtifact);
        }
        const previous = this.chatLocks.get(message.chatId) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.chatLocks.set(message.chatId, current);
        await previous;
        try {
            return await this.routeSerialized(message, onReplyMarkup, onArtifact);
        }
        finally {
            release();
            if (this.chatLocks.get(message.chatId) === current)
                this.chatLocks.delete(message.chatId);
        }
    }
    async routeSerialized(message, onReplyMarkup, onArtifact) {
        logger_1.log.info(message.traceId, "route.started", {
            provider: message.provider,
            chatId: message.chatId,
        });
        try {
            const reply = await this.runtime.execute(message, (signal) => this.routeInner(message, onReplyMarkup, onArtifact, signal));
            logger_1.log.info(message.traceId, "route.completed", {});
            return reply;
        }
        catch (error) {
            logger_1.log.error(message.traceId, "route.completed", { error });
            throw error;
        }
    }
    async routeInner(message, onReplyMarkup, onArtifact, signal) {
        const text = message.text.trim();
        const normalized = text.toLowerCase();
        if (normalized === "/stop") {
            const cancelledRunId = this.runtime.cancelActiveRun(message.chatId);
            const result = (0, commands_1.stopRunningCommand)();
            const runId = result.traceId || cancelledRunId;
            if (!runId)
                return "Không có run hoặc lệnh nào đang chạy.";
            logger_1.log.info(message.traceId, "run.stop.requested", { runningTraceId: result.traceId, runId });
            return `Đã yêu cầu dừng run đang chạy (traceId: ${runId}).`;
        }
        if (normalized === "/reset") {
            const newSessionId = (0, repositories_1.resetSession)(message.chatId);
            logger_1.log.info(message.traceId, "chat.history.reset", { chatId: message.chatId, newSessionId });
            return "Đã bắt đầu phiên trò chuyện mới. Lịch sử cũ đã được lưu trữ!";
        }
        if (normalized === "/schedule") {
            return (0, scheduler_1.formatScheduleList)((0, scheduler_1.loadScheduledChecks)());
        }
        if (normalized.startsWith("/schedule show ")) {
            const name = normalized.replace("/schedule show ", "").trim();
            return (0, scheduler_1.formatScheduleDetails)(name);
        }
        if (normalized.startsWith("/schedule history ")) {
            const name = normalized.replace("/schedule history ", "").trim();
            return (0, scheduler_1.formatScheduleHistory)(name);
        }
        if (normalized.startsWith("/schedule run ")) {
            const name = normalized.replace("/schedule run ", "").trim();
            const check = (0, scheduler_1.findScheduledCheck)(name);
            if (!check)
                return `Scheduled check not found: ${name}`;
            const result = await (0, scheduler_1.runScheduledCheck)({
                check,
                principalId: message.userId,
                chatId: message.chatId,
                defaultTimeoutMs: this.commandTimeoutMs,
            });
            return (0, scheduler_1.formatScheduledCheckResult)(result);
        }
        const runtimeSchedule = this.parseRuntimeSchedule(normalized);
        if (runtimeSchedule) {
            try {
                if (runtimeSchedule.action === "add") {
                    const check = (0, scheduler_1.createRuntimeSchedule)({
                        name: runtimeSchedule.name,
                        command: runtimeSchedule.command,
                        cron: runtimeSchedule.cron,
                        enabled: true,
                    });
                    return `Created runtime schedule ${check.name} (${check.cron}) for ${check.command.name}.`;
                }
                if (!(0, scheduler_1.removeRuntimeSchedule)(runtimeSchedule.name)) {
                    return `Runtime schedule not found: ${runtimeSchedule.name}. Config schedules must be removed from config.json.`;
                }
                return `Deleted runtime schedule ${runtimeSchedule.name}.`;
            }
            catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        }
        const scheduleUpdate = this.parseScheduleUpdate(normalized);
        if (scheduleUpdate) {
            const row = (0, repositories_1.getScheduledJob)(scheduleUpdate.name);
            if (!row)
                return `Scheduled check not found: ${scheduleUpdate.name}`;
            const versionedScheduleUpdate = { ...scheduleUpdate, expectedVersion: row.version };
            const { preview, digest } = (0, scheduler_1.scheduleUpdatePreview)(versionedScheduleUpdate);
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
            const pending = this.approvals.create({
                runId: message.traceId, principalId: message.userId, chatId: message.chatId,
                description: `Cho phép cập nhật schedule ${scheduleUpdate.name} trong run này.`,
                actionDigest: digest, payload: { scheduleUpdate: versionedScheduleUpdate }, expiresAt,
            });
            if (onReplyMarkup) {
                onReplyMarkup({
                    inline_keyboard: [
                        [
                            {
                                text: "✅ Approve", callback_data: `approve ${pending.short_id}`,
                            },
                            {
                                text: "❌ Reject", callback_data: `reject ${pending.short_id}`,
                            },
                        ],
                    ],
                });
            }
            return [
                `Schedule update needs confirmation.`,
                `Action: ${scheduleUpdate.action}`,
                `Name: ${scheduleUpdate.name}`,
                `Version: ${row.version}`,
                scheduleUpdate.value === undefined ? "" : `Value: ${scheduleUpdate.value}`,
                `Approval ID: ${pending.short_id}`,
                `Gõ: approve ${pending.short_id} hoặc reject ${pending.short_id}`,
            ].filter(Boolean).join("\n");
        }
        if ((0, debugCommands_1.isDebugCommand)(text)) {
            logger_1.log.info(message.traceId, normalized.startsWith("/debug ") ? "debug.trace.requested" : "system.status.requested", { command: normalized });
            return (0, debugCommands_1.handleDebugCommand)(text, this.registry);
        }
        const toolScopedApproval = await this.toolLoop.consumeScopedApproval(message, onArtifact, onReplyMarkup);
        if (toolScopedApproval)
            return toolScopedApproval;
        const scopedApproval = await this.consumeScopedApproval(message, signal);
        if (scopedApproval)
            return scopedApproval;
        const catalog = (0, commands_1.loadCommandCatalog)();
        const action = catalog.byAlias[normalized];
        if (action) {
            return this.prepareOrRun(message, action, onReplyMarkup, signal);
        }
        if (normalized.startsWith("/")) {
            return `Lệnh không tồn tại. Danh sách lệnh hỗ trợ:\n\n${(0, debugCommands_1.handleDebugCommand)("/commands", this.registry)}`;
        }
        return this.runtime.runAgent(message, onReplyMarkup, onArtifact, signal);
    }
    async prepareOrRun(message, action, onReplyMarkup, signal) {
        const prepared = this.runtime.prepareCommand(action, this.commandTimeoutMs, message.text);
        if (prepared.blocked) {
            return `Từ chối [${prepared.blocked.code}]: ${prepared.blocked.summary}`;
        }
        if (prepared.requiresConfirmation) {
            const preview = (0, commands_1.previewCommand)(action, this.commandTimeoutMs);
            const digest = prepared.digest;
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
            const pending = this.approvals.create({
                runId: message.traceId,
                principalId: message.userId,
                chatId: message.chatId,
                description: `Cho phép chạy ${action.label} trong run này.`,
                actionDigest: digest,
                payload: { action, preview },
                expiresAt,
            });
            if (onReplyMarkup) {
                onReplyMarkup({
                    inline_keyboard: [
                        [
                            {
                                text: "✅ Approve",
                                callback_data: `approve ${pending.short_id}`,
                            },
                            {
                                text: "❌ Reject",
                                callback_data: `reject ${pending.short_id}`,
                            },
                        ],
                    ],
                });
            }
            return [
                `${action.label} cần xác nhận trước khi chạy.`,
                `Executable: ${preview.executable}`,
                `Args: ${JSON.stringify(preview.args)}`,
                `Cwd: ${preview.cwd}`,
                `Timeout: ${preview.timeoutMs} ms`,
                `Phạm vi: Cho phép chạy ${action.label} trong run này.`,
                `Approval ID: ${pending.short_id}`,
                `Gõ: approve ${pending.short_id} hoặc reject ${pending.short_id}`,
            ].join("\n");
        }
        return this.run(message, action, false, signal);
    }
    async consumeScopedApproval(message, signal) {
        const match = message.text.trim().toLowerCase().match(/^(approve|reject)\s+([a-f0-9]{8})$/);
        if (!match)
            return null;
        const candidate = this.approvals.get(match[2], message.userId, message.chatId);
        if (!candidate)
            return "Approval không tồn tại, đã hết hạn, hoặc không còn hợp lệ.";
        let payload;
        try {
            payload = JSON.parse(candidate.payload_json);
            if (payload.scheduleUpdate) {
                const digest = (0, scheduler_1.scheduleUpdatePreview)(payload.scheduleUpdate).digest;
                const pending = this.approvals.resolve({ shortId: match[2], principalId: message.userId, chatId: message.chatId, actionDigest: digest, approve: match[1] === "approve" });
                if (!pending)
                    return "Approval không tồn tại, đã hết hạn, hoặc action đã thay đổi.";
                if (match[1] === "reject")
                    return "Đã từ chối action đang chờ.";
                const result = (0, scheduler_1.applyScheduleUpdate)(payload.scheduleUpdate);
                (0, repositories_1.finishRun)(pending.run_id, "completed");
                return result;
            }
            if (!payload.action)
                return null;
        }
        catch {
            return "Approval không còn hợp lệ.";
        }
        const digest = (0, commands_1.commandPreviewDigest)((0, commands_1.previewCommand)(payload.action, this.commandTimeoutMs));
        const pending = this.approvals.resolve({
            shortId: match[2], principalId: message.userId, chatId: message.chatId,
            actionDigest: digest, approve: match[1] === "approve",
        });
        if (!pending)
            return "Approval không tồn tại, đã hết hạn, hoặc không còn hợp lệ.";
        if (match[1] === "reject")
            return "Đã từ chối action đang chờ.";
        try {
            const result = await this.run(message, payload.action, true, signal);
            (0, repositories_1.finishRun)(pending.run_id, "completed");
            return result;
        }
        catch (error) {
            (0, repositories_1.finishRun)(pending.run_id, "failed", error instanceof Error ? error.message : String(error));
            throw error;
        }
    }
    parseScheduleUpdate(normalized) {
        const parts = normalized.split(/\s+/);
        if (parts[0] !== "/schedule")
            return null;
        if ((parts[1] === "enable" || parts[1] === "disable") && parts[2]) {
            return { action: parts[1], name: parts[2] };
        }
        // /schedule cron <name> <5-field cron expr>
        if (parts[1] === "cron" && parts[2] && parts.length >= 8) {
            return { action: "cron", name: parts[2], value: parts.slice(3).join(" ") };
        }
        if (parts[1] === "delivery" && parts[2] && parts[3]) {
            return { action: "delivery", name: parts[2], value: parts[3] };
        }
        return null;
    }
    parseRuntimeSchedule(normalized) {
        const parts = normalized.split(/\s+/);
        if (parts[0] !== "/schedule")
            return null;
        if (parts[1] === "delete" && parts[2] && parts.length === 3) {
            return { action: "delete", name: parts[2] };
        }
        // /schedule add <name> <minute> <hour> <day-of-month> <month> <day-of-week> <command>
        if (parts[1] === "add" && parts.length === 9) {
            return { action: "add", name: parts[2], cron: parts.slice(3, 8).join(" "), command: parts[8] };
        }
        return null;
    }
    async run(message, action, confirmationGranted = false, signal) {
        const prepared = this.runtime.prepareCommand(action, this.commandTimeoutMs, message.text);
        if (prepared.blocked)
            throw new Error(`Permission deny: ${prepared.blocked.summary}`);
        const result = await this.runtime.runCommand(action, {
            runId: message.traceId,
            traceId: message.traceId,
            chatId: message.chatId,
            defaultTimeoutMs: this.commandTimeoutMs,
            confirmationGranted,
            userIntent: message.text,
            signal,
        });
        const data = result.data;
        return (0, presenter_1.presentCommandResult)({
            label: action.label,
            traceId: message.traceId,
            ok: result.ok,
            exit: String(data?.exitCode ?? data?.signal ?? "unknown"),
            output: data?.output || result.summary,
        });
    }
}
exports.Router = Router;
