"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Compactor = void 0;
const router_1 = require("../brain/router");
const app_1 = require("../config/app");
const repositories_1 = require("../storage/repositories");
const trace_1 = require("../logging/trace");
const logger_1 = require("../logging/logger");
const checkpoint_1 = require("./checkpoint");
const memory_1 = require("./memory");
const token_estimate_1 = require("./token-estimate");
class Compactor {
    options;
    ai = new router_1.AiRouter();
    activeCompactions = new Set();
    constructor(options = {}) {
        this.options = options;
    }
    async compactIfNeeded(chatId) {
        if (this.activeCompactions.has(chatId)) {
            logger_1.log.info("compactor", "compaction.skipped.already_running", { chatId });
            return;
        }
        const sessionId = (0, repositories_1.getActiveSessionId)(chatId);
        const messages = (0, repositories_1.getUncompactedChatMessages)(chatId, sessionId);
        const recentTailTokens = this.options.recentTailTokens
            ?? (0, app_1.loadAgentConfig)().context?.recentTailTokens
            ?? 20_000;
        const tokensBefore = (0, token_estimate_1.estimateTokens)(messages.map((message) => ({ role: message.role, content: message.content })));
        if (tokensBefore <= recentTailTokens) {
            return;
        }
        this.activeCompactions.add(chatId);
        const traceId = (0, trace_1.generateTraceId)();
        logger_1.log.info(traceId, "compaction.started", { chatId, sessionId, totalMessages: messages.length });
        let keptTokens = 0;
        let firstKeptIndex = messages.length;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const entryTokens = (0, token_estimate_1.estimateTokens)({ role: messages[index].role, content: messages[index].content });
            if (keptTokens > 0 && keptTokens + entryTokens > recentTailTokens)
                break;
            keptTokens += entryTokens;
            firstKeptIndex = index;
        }
        const targetMessages = messages.slice(0, firstKeptIndex);
        if (targetMessages.length === 0)
            return;
        const previousRow = (0, repositories_1.getContextCheckpoint)(chatId, sessionId);
        const compactedTraceIds = new Set(targetMessages.map((message) => message.trace_id));
        const formattedHistory = [
            previousRow ? `[PREVIOUS CHECKPOINT]\n${previousRow.checkpoint_json}` : "",
            targetMessages
                .map((m) => {
                const roleLabel = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
                return `${roleLabel}: ${m.content}`;
            })
                .join("\n\n"),
            ...(0, repositories_1.listSessionToolContextBlocks)(chatId)
                .filter((step) => compactedTraceIds.has(step.trace_id))
                .map((step) => `Tool call: ${step.call_json}\nTool result: ${step.result_json}`),
        ].filter(Boolean).join("\n\n");
        const systemPrompt = [
            "Bạn là trợ lý lưu checkpoint hội thoại. Đọc lịch sử được đưa vào và tạo checkpoint ngắn, không suy đoán.",
            "Chỉ trả về JSON hợp lệ, không markdown, với đúng các key: goals, constraints, completed, inProgress, blockers, decisions, nextSteps, criticalContext, importantIdentifiers.",
            "Mọi key trừ decisions là mảng string. decisions là mảng object {decision, rationale?}. Giữ goal, quyết định, tiến độ, blocker, next step, path/error/ID quan trọng.",
        ].join("\n");
        try {
            // Sử dụng custom system prompt chuyên cho compaction
            const summarizer = new router_1.AiRouter({ systemPrompt });
            const response = await summarizer.complete(traceId, {
                history: [],
                runtime: {
                    currentTime: new Date().toISOString(),
                    timezone: "Asia/Ho_Chi_Minh",
                    locale: "vi-VN",
                },
            }, formattedHistory, [], []);
            const summary = response.text?.trim();
            if (!summary) {
                throw new Error("AI returned an empty summary.");
            }
            const previous = previousRow;
            let previousCheckpoint = null;
            try {
                previousCheckpoint = previous ? JSON.parse(previous.checkpoint_json) : null;
            }
            catch { }
            const checkpoint = (0, checkpoint_1.checkpointFromModelResponse)(summary, previousCheckpoint);
            const flushedMemoryFile = (0, memory_1.flushCheckpointToDailyMemory)(checkpoint);
            const messageIds = targetMessages.map((m) => m.id);
            const compactedSessionId = `${sessionId}:compacted`;
            (0, repositories_1.saveContextCheckpoint)({
                chatId,
                sessionId,
                checkpoint,
                firstKeptMessageId: messages[firstKeptIndex]?.id || null,
                tokensBefore,
            });
            (0, repositories_1.markMessagesAsCompacted)(messageIds, compactedSessionId);
            logger_1.log.info(traceId, "compaction.completed", {
                chatId,
                sessionId,
                compactedCount: messageIds.length,
                firstKeptMessageId: messages[firstKeptIndex]?.id || null,
                tokensBefore,
                flushedMemoryFile,
            });
        }
        catch (err) {
            logger_1.log.error(traceId, "compaction.failed", { error: err });
            throw err;
        }
        finally {
            this.activeCompactions.delete(chatId);
        }
    }
}
exports.Compactor = Compactor;
