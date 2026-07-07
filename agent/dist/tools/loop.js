"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentToolLoop = void 0;
const router_1 = require("../brain/router");
const logger_1 = require("../logging/logger");
const repositories_1 = require("../storage/repositories");
const executor_1 = require("./executor");
const MAX_TOOL_STEPS = 4;
function formatResult(result) {
    const data = result.data === undefined ? "" : `\n${JSON.stringify(result.data, null, 2)}`;
    return `${result.ok ? "Tool completed" : "Tool failed"} [${result.code}]\n${result.summary}${data}`;
}
class AgentToolLoop {
    ai;
    executor;
    constructor(ai = new router_1.AiRouter(), executor = new executor_1.ToolExecutor()) {
        this.ai = ai;
        this.executor = executor;
    }
    async run(message, context) {
        const steps = [];
        const tools = this.executor.definitions();
        for (let index = 0; index < MAX_TOOL_STEPS; index += 1) {
            const response = await this.ai.complete(message.traceId, context, message.text, tools, steps);
            if (response.clarification) {
                logger_1.log.info(message.traceId, "ai.clarification.requested", { step: index });
                return response.clarification;
            }
            if (response.text)
                return response.text;
            if (!response.toolCall)
                throw new Error("AI response did not contain a valid outcome.");
            logger_1.log.info(message.traceId, "ai.tool.selected", {
                step: index,
                toolName: response.toolCall.name,
            });
            try {
                const prepared = this.executor.prepare(response.toolCall, message.traceId);
                if (prepared.requiresConfirmation) {
                    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
                    const pending = {
                        kind: "ai-tool",
                        call: prepared.call,
                        digest: prepared.digest,
                        preview: prepared.preview,
                    };
                    (0, repositories_1.upsertPendingConfirmation)({
                        chatId: message.chatId,
                        traceId: message.traceId,
                        commandName: prepared.key,
                        payload: pending,
                        expiresAt,
                    });
                    logger_1.log.info(message.traceId, "ai.tool.confirmation_required", {
                        toolName: prepared.call.name,
                        confirmationKey: prepared.key,
                    });
                    return [
                        `${prepared.key} cần xác nhận trước khi chạy.`,
                        prepared.preview,
                        `Approval: ${prepared.digest.slice(0, 12)}`,
                        `Gõ: confirm ${prepared.key} ${prepared.digest.slice(0, 12)}`,
                    ].join("\n");
                }
                const result = await this.executor.execute(prepared, {
                    traceId: message.traceId,
                    chatId: message.chatId,
                });
                steps.push({ call: response.toolCall, result });
                logger_1.log.info(message.traceId, "ai.tool.completed", {
                    step: index,
                    toolName: response.toolCall.name,
                    ok: result.ok,
                    code: result.code,
                });
            }
            catch (error) {
                const result = {
                    ok: false,
                    code: "INVALID_TOOL_CALL",
                    summary: error instanceof Error ? error.message : String(error),
                };
                steps.push({ call: response.toolCall, result });
                logger_1.log.warn(message.traceId, "ai.tool.rejected", {
                    step: index,
                    toolName: response.toolCall.name,
                    reason: result.summary,
                });
            }
        }
        return `Đã dừng sau ${MAX_TOOL_STEPS} bước tool để tránh vòng lặp tự động. Hãy thu hẹp yêu cầu hoặc thử lại.`;
    }
    async consumeConfirmation(message) {
        const text = message.text.trim().toLowerCase();
        if (!text.startsWith("confirm"))
            return null;
        const pending = (0, repositories_1.getPendingConfirmation)(message.chatId);
        if (!pending)
            return null;
        let payload;
        try {
            payload = JSON.parse(pending.payload_json);
        }
        catch {
            return null;
        }
        if (payload.kind !== "ai-tool")
            return null;
        const match = text.match(/^confirm\s+(\S+)\s+([a-f0-9]{12})$/);
        if (!match)
            return "Confirmation cần tool name và approval token từ preview.";
        if (pending.expires_at <= (0, repositories_1.nowIso)()) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            return "Confirmation đã hết hạn. Gửi lại yêu cầu để tạo preview mới.";
        }
        let prepared;
        try {
            prepared = this.executor.prepare(payload.call, message.traceId);
        }
        catch (error) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            return `Confirmation không còn hợp lệ: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (prepared.key.toLowerCase() !== match[1] ||
            prepared.digest !== payload.digest ||
            prepared.digest.slice(0, 12) !== match[2]) {
            return "Confirmation không khớp action đã preview.";
        }
        (0, repositories_1.deletePendingConfirmation)(message.chatId);
        const result = await this.executor.execute(prepared, {
            traceId: message.traceId,
            chatId: message.chatId,
            confirmationGranted: true,
        });
        logger_1.log.info(message.traceId, "ai.tool.confirmed", {
            toolName: prepared.call.name,
            ok: result.ok,
            code: result.code,
        });
        return formatResult(result);
    }
}
exports.AgentToolLoop = AgentToolLoop;
