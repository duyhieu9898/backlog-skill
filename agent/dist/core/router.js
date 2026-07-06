"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = void 0;
const app_1 = require("../config/app");
const commands_1 = require("../commands");
const hydrator_1 = require("../context/hydrator");
const logger_1 = require("../logging/logger");
const router_1 = require("../brain/router");
const repositories_1 = require("../storage/repositories");
const debugCommands_1 = require("./debugCommands");
const presenter_1 = require("./presenter");
class Router {
    registry;
    hydrator;
    ai = new router_1.AiRouter();
    commandTimeoutMs;
    constructor(registry) {
        this.registry = registry;
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
        const aiResponse = await this.ai.complete(message.traceId, this.hydrator.toPromptSections(context), message.text);
        if (aiResponse.clarification)
            return aiResponse.clarification;
        if (aiResponse.commandName) {
            const selected = catalog.allow.find((command) => command.name === aiResponse.commandName);
            if (!selected)
                return `AI chọn command không nằm trong allowlist: ${aiResponse.commandName}`;
            logger_1.log.info(message.traceId, "ai.tool.selected", {
                commandName: aiResponse.commandName,
            });
            return this.prepareOrRun(message, selected);
        }
        return aiResponse.text || "Mình chưa hiểu yêu cầu. Gõ /commands để xem lệnh hỗ trợ.";
    }
    async prepareOrRun(message, action) {
        const decision = (0, commands_1.evaluateCommandPermission)(action);
        if (decision.outcome === "deny") {
            return `Từ chối [${decision.reasonCode}]: ${decision.reason}`;
        }
        if (decision.outcome === "confirm") {
            const preview = (0, commands_1.previewCommand)(action, this.commandTimeoutMs);
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
            (0, repositories_1.upsertPendingConfirmation)({
                chatId: message.chatId,
                traceId: message.traceId,
                commandName: action.name || action.label,
                payload: { action, preview },
                expiresAt,
            });
            return [
                `${action.label} cần xác nhận trước khi chạy.`,
                `Executable: ${preview.executable}`,
                `Args: ${JSON.stringify(preview.args)}`,
                `Cwd: ${preview.cwd}`,
                `Timeout: ${preview.timeoutMs} ms`,
                `Gõ: confirm ${action.name || action.label}`,
            ].join("\n");
        }
        return this.run(message, action, false);
    }
    async consumeConfirmation(message) {
        const match = message.text.trim().toLowerCase().match(/^confirm\s+(.+)$/);
        if (!match)
            return null;
        const pending = (0, repositories_1.getPendingConfirmation)(message.chatId);
        if (!pending)
            return "Không có confirmation nào đang chờ.";
        if (pending.expires_at <= (0, repositories_1.nowIso)()) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            return "Confirmation đã hết hạn. Gửi lại command để tạo confirmation mới.";
        }
        if (pending.command_name.toLowerCase() !== match[1]) {
            return `Confirmation không khớp. Command đang chờ: ${pending.command_name}`;
        }
        (0, repositories_1.deletePendingConfirmation)(message.chatId);
        const payload = JSON.parse(pending.payload_json);
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
