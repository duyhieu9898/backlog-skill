"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = void 0;
const app_1 = require("../config/app");
const commands_1 = require("../commands");
const hydrator_1 = require("../context/hydrator");
const logger_1 = require("../logging/logger");
const repositories_1 = require("../storage/repositories");
const loop_1 = require("../tools/loop");
const debugCommands_1 = require("./debugCommands");
const presenter_1 = require("./presenter");
const scheduler_1 = require("../scheduler");
class Router {
    registry;
    toolLoop;
    hydrator;
    commandTimeoutMs;
    constructor(registry, toolLoop = new loop_1.AgentToolLoop()) {
        this.registry = registry;
        this.toolLoop = toolLoop;
        this.hydrator = new hydrator_1.ContextHydrator(registry);
        this.commandTimeoutMs = (0, app_1.loadAgentConfig)().runtime?.commandTimeoutMs || 10 * 60 * 1000;
    }
    async route(message, onReplyMarkup, onArtifact) {
        logger_1.log.info(message.traceId, "route.started", {
            provider: message.provider,
            chatId: message.chatId,
        });
        (0, repositories_1.insertChatMessage)({
            chatId: message.chatId,
            userId: message.userId,
            role: "user",
            content: message.text,
            traceId: message.traceId,
        });
        let reply;
        try {
            reply = await this.routeInner(message, onReplyMarkup, onArtifact);
            (0, repositories_1.insertChatMessage)({
                chatId: message.chatId,
                userId: "agent",
                role: "assistant",
                content: reply,
                traceId: message.traceId,
            });
            logger_1.log.info(message.traceId, "route.completed", {});
            return reply;
        }
        catch (error) {
            logger_1.log.error(message.traceId, "route.completed", { error });
            throw error;
        }
    }
    async routeInner(message, onReplyMarkup, onArtifact) {
        const text = message.text.trim();
        const normalized = text.toLowerCase();
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
                chatId: message.chatId,
                defaultTimeoutMs: this.commandTimeoutMs,
            });
            return (0, scheduler_1.formatScheduledCheckResult)(result);
        }
        const scheduleUpdate = this.parseScheduleUpdate(normalized);
        if (scheduleUpdate) {
            const row = (0, repositories_1.getScheduledJob)(scheduleUpdate.name);
            if (!row)
                return `Scheduled check not found: ${scheduleUpdate.name}`;
            const versionedScheduleUpdate = { ...scheduleUpdate, expectedVersion: row.version };
            const { preview, digest } = (0, scheduler_1.scheduleUpdatePreview)(versionedScheduleUpdate);
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
            (0, repositories_1.upsertPendingConfirmation)({
                chatId: message.chatId,
                traceId: message.traceId,
                commandName: `schedule.${scheduleUpdate.action}.${scheduleUpdate.name}`,
                payload: { scheduleUpdate: versionedScheduleUpdate, preview, digest },
                expiresAt,
            });
            if (onReplyMarkup) {
                onReplyMarkup({
                    inline_keyboard: [
                        [
                            {
                                text: `✅ Xác nhận Update Schedule`,
                                callback_data: `confirm schedule.${scheduleUpdate.action}.${scheduleUpdate.name} ${digest.slice(0, 12)}`,
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
                `Approval: ${digest.slice(0, 12)}`,
                `Gõ: confirm schedule.${scheduleUpdate.action}.${scheduleUpdate.name} ${digest.slice(0, 12)}`,
            ].filter(Boolean).join("\n");
        }
        if ((0, debugCommands_1.isDebugCommand)(text)) {
            logger_1.log.info(message.traceId, normalized.startsWith("/debug ") ? "debug.trace.requested" : "system.status.requested", { command: normalized });
            return (0, debugCommands_1.handleDebugCommand)(text, this.registry);
        }
        const toolConfirmed = await this.toolLoop.consumeConfirmation(message, onArtifact);
        if (toolConfirmed)
            return toolConfirmed;
        const confirmed = await this.consumeConfirmation(message);
        if (confirmed)
            return confirmed;
        const catalog = (0, commands_1.loadCommandCatalog)();
        const action = catalog.byAlias[normalized];
        if (action) {
            await this.cancelPending(message.chatId);
            return this.prepareOrRun(message, action, onReplyMarkup);
        }
        if (normalized.startsWith("/")) {
            return `Lệnh không tồn tại. Danh sách lệnh hỗ trợ:\n\n${(0, debugCommands_1.handleDebugCommand)("/commands", this.registry)}`;
        }
        const context = this.hydrator.hydrate(message);
        return this.toolLoop.run(message, context.prompt, onReplyMarkup, onArtifact);
    }
    async prepareOrRun(message, action, onReplyMarkup) {
        const decision = (0, commands_1.evaluateCommandPermission)(action);
        if (decision.outcome === "deny") {
            return `Từ chối [${decision.reasonCode}]: ${decision.reason}`;
        }
        if (decision.outcome === "confirm") {
            const preview = (0, commands_1.previewCommand)(action, this.commandTimeoutMs);
            const digest = (0, commands_1.commandPreviewDigest)(preview);
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
            (0, repositories_1.upsertPendingConfirmation)({
                chatId: message.chatId,
                traceId: message.traceId,
                commandName: action.name || action.label,
                payload: { action, preview, digest },
                expiresAt,
            });
            if (onReplyMarkup) {
                onReplyMarkup({
                    inline_keyboard: [
                        [
                            {
                                text: `✅ Xác nhận: ${action.label}`,
                                callback_data: `confirm ${action.name || action.label} ${digest.slice(0, 12)}`,
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
                `Approval: ${digest.slice(0, 12)}`,
                `Gõ: confirm ${action.name || action.label} ${digest.slice(0, 12)}`,
            ].join("\n");
        }
        return this.run(message, action, false);
    }
    async consumeConfirmation(message) {
        const text = message.text.trim().toLowerCase();
        // Check if it's a confirmation message
        const isShortConfirm = text === "y" || text === "yes" || text === "confirm";
        const matchTokenOnly = text.match(/^confirm\s+([a-f0-9]{12})$/);
        const matchFull = text.match(/^confirm\s+(\S+)\s+([a-f0-9]{12})$/);
        if (!isShortConfirm && !matchTokenOnly && !matchFull) {
            if (text.startsWith("confirm")) {
                return "Confirmation cần command name và approval token từ preview, hoặc chỉ cần gõ 'confirm', 'y', 'yes'.";
            }
            return null;
        }
        const pending = (0, repositories_1.getPendingConfirmation)(message.chatId);
        if (!pending) {
            if (text.startsWith("confirm") || text === "y" || text === "yes") {
                return "Không có confirmation nào đang chờ.";
            }
            return null;
        }
        if (pending.expires_at <= (0, repositories_1.nowIso)()) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            return "Confirmation đã hết hạn. Gửi lại command để tạo confirmation mới.";
        }
        let payload;
        let recomputedDigest;
        try {
            payload = JSON.parse(pending.payload_json);
            if (payload.scheduleUpdate) {
                recomputedDigest = (0, scheduler_1.scheduleUpdatePreview)(payload.scheduleUpdate).digest;
                if (payload.digest !== recomputedDigest) {
                    throw new Error("Pending schedule update digest mismatch.");
                }
                // Match check
                if (matchFull) {
                    if (pending.command_name.toLowerCase() !== matchFull[1] || payload.digest.slice(0, 12) !== matchFull[2]) {
                        return `Confirmation không khớp. Dùng đúng command và approval token trong preview.`;
                    }
                }
                else if (matchTokenOnly) {
                    if (payload.digest.slice(0, 12) !== matchTokenOnly[1]) {
                        return `Confirmation token không khớp.`;
                    }
                }
                // If isShortConfirm (just "confirm", "y", "yes"), we auto-match without token check.
                (0, repositories_1.deletePendingConfirmation)(message.chatId);
                return (0, scheduler_1.applyScheduleUpdate)(payload.scheduleUpdate);
            }
            if (!payload.action || !payload.preview || typeof payload.digest !== "string") {
                throw new Error("Pending confirmation payload is incomplete.");
            }
            recomputedDigest = (0, commands_1.commandPreviewDigest)((0, commands_1.previewCommand)(payload.action, this.commandTimeoutMs));
            if (payload.digest !== recomputedDigest || (0, commands_1.commandPreviewDigest)(payload.preview) !== recomputedDigest) {
                throw new Error("Pending confirmation digest mismatch.");
            }
        }
        catch (error) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            logger_1.log.warn(message.traceId, "confirmation.integrity_failed", {
                commandName: pending.command_name,
                error: error instanceof Error ? error.message : String(error),
            });
            return "Confirmation không còn hợp lệ vì action đã thay đổi. Gửi lại command để tạo preview mới.";
        }
        // Match check for commands
        if (matchFull) {
            if (pending.command_name.toLowerCase() !== matchFull[1] || payload.digest.slice(0, 12) !== matchFull[2]) {
                return `Confirmation không khớp. Dùng đúng command và approval token trong preview.`;
            }
        }
        else if (matchTokenOnly) {
            if (payload.digest.slice(0, 12) !== matchTokenOnly[1]) {
                return `Confirmation token không khớp.`;
            }
        }
        (0, repositories_1.deletePendingConfirmation)(message.chatId);
        return this.run(message, payload.action, true);
    }
    parseScheduleUpdate(normalized) {
        const parts = normalized.split(/\s+/);
        if (parts[0] !== "/schedule")
            return null;
        if ((parts[1] === "enable" || parts[1] === "disable") && parts[2]) {
            return { action: parts[1], name: parts[2] };
        }
        if (parts[1] === "interval" && parts[2] && parts[3]) {
            return { action: "interval", name: parts[2], value: Number(parts[3]) };
        }
        if (parts[1] === "delivery" && parts[2] && parts[3]) {
            return { action: "delivery", name: parts[2], value: parts[3] };
        }
        return null;
    }
    async cancelPending(chatId) {
        if ((0, repositories_1.getPendingConfirmation)(chatId))
            (0, repositories_1.deletePendingConfirmation)(chatId);
    }
    async run(message, action, confirmationGranted = false) {
        const result = await (0, commands_1.runTrackedCommand)({
            traceId: message.traceId,
            chatId: message.chatId,
            action,
            defaultTimeoutMs: this.commandTimeoutMs,
            confirmationGranted,
        });
        const ok = result.exitCode === 0 && !result.signal;
        return (0, presenter_1.presentCommandResult)({
            label: action.label,
            traceId: message.traceId,
            ok,
            exit: String(result.exitCode || result.signal || "unknown"),
            output: result.output,
        });
    }
}
exports.Router = Router;
