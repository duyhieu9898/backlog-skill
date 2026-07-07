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
    async route(message) {
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
            reply = await this.routeInner(message);
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
    async routeInner(message) {
        const text = message.text.trim();
        const normalized = text.toLowerCase();
        if ((0, debugCommands_1.isDebugCommand)(text)) {
            logger_1.log.info(message.traceId, normalized.startsWith("/debug ") ? "debug.trace.requested" : "system.status.requested", { command: normalized });
            return (0, debugCommands_1.handleDebugCommand)(text, this.registry);
        }
        const toolConfirmed = await this.toolLoop.consumeConfirmation(message);
        if (toolConfirmed)
            return toolConfirmed;
        const confirmed = await this.consumeConfirmation(message);
        if (confirmed)
            return confirmed;
        const catalog = (0, commands_1.loadCommandCatalog)();
        const action = catalog.byAlias[normalized];
        if (action) {
            await this.cancelPending(message.chatId);
            return this.prepareOrRun(message, action);
        }
        if (normalized.startsWith("/")) {
            return `Lệnh không tồn tại. Danh sách lệnh hỗ trợ:\n\n${(0, debugCommands_1.handleDebugCommand)("/commands", this.registry)}`;
        }
        const context = this.hydrator.hydrate(message);
        return this.toolLoop.run(message, this.hydrator.toPromptSections(context));
    }
    async prepareOrRun(message, action) {
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
        const confirmationText = message.text.trim().toLowerCase();
        if (!confirmationText.startsWith("confirm"))
            return null;
        const match = confirmationText.match(/^confirm\s+(\S+)\s+([a-f0-9]{12})$/);
        if (!match)
            return "Confirmation cần command name và approval token từ preview.";
        const pending = (0, repositories_1.getPendingConfirmation)(message.chatId);
        if (!pending)
            return "Không có confirmation nào đang chờ.";
        if (pending.expires_at <= (0, repositories_1.nowIso)()) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            return "Confirmation đã hết hạn. Gửi lại command để tạo confirmation mới.";
        }
        let payload;
        let recomputedDigest;
        try {
            payload = JSON.parse(pending.payload_json);
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
        if (pending.command_name.toLowerCase() !== match[1] || payload.digest.slice(0, 12) !== match[2]) {
            return `Confirmation không khớp. Dùng đúng command và approval token trong preview.`;
        }
        (0, repositories_1.deletePendingConfirmation)(message.chatId);
        return this.run(message, payload.action, true);
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
