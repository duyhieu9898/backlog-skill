"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Compactor = void 0;
const router_1 = require("../brain/router");
const repositories_1 = require("../storage/repositories");
const trace_1 = require("../logging/trace");
const logger_1 = require("../logging/logger");
class Compactor {
    ai = new router_1.AiRouter();
    async compactIfNeeded(chatId) {
        const sessionId = (0, repositories_1.getActiveSessionId)(chatId);
        const messages = (0, repositories_1.getUncompactedChatMessages)(chatId, sessionId);
        // Chỉ compaction khi số tin nhắn vượt quá 15
        if (messages.length <= 15) {
            return;
        }
        const traceId = (0, trace_1.generateTraceId)();
        logger_1.log.info(traceId, "compaction.started", { chatId, sessionId, totalMessages: messages.length });
        // Lấy 10 tin nhắn đầu tiên để tóm tắt
        const targetMessages = messages.slice(0, 10);
        const formattedHistory = targetMessages
            .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
            .join("\n\n");
        const systemPrompt = [
            "Bạn là trợ lý ảo lưu trữ. Nhiệm vụ của bạn là đọc lịch sử chat dưới đây và tóm tắt nó thành một đoạn tóm tắt cực kỳ ngắn gọn (dưới 500 ký tự).",
            "Bản tóm tắt phải làm rõ: những gì đã thảo luận, các quyết định/lệnh nào đã được đưa ra hoặc hoàn thành.",
            "Chỉ trả về đoạn tóm tắt thô bằng tiếng Việt, không thêm lời chào, không định dạng JSON, không giải thích gì thêm.",
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
            const messageIds = targetMessages.map((m) => m.id);
            const compactedSessionId = `${sessionId}:compacted`;
            // Tạo timestamp cũ hơn tin nhắn đầu tiên 1 giây để bản tóm tắt luôn đứng đầu lịch sử
            const summaryCreatedAt = new Date(new Date(targetMessages[0].created_at).getTime() - 1000).toISOString();
            // Lưu bản tóm tắt vào active session
            (0, repositories_1.insertChatMessage)({
                chatId,
                userId: "system",
                role: "system",
                content: `[Bản tóm tắt lịch sử cuộc trò chuyện cũ: ${summary}]`,
                traceId,
                sessionId,
                createdAt: summaryCreatedAt,
            });
            // Đánh dấu các tin nhắn cũ là compacted
            (0, repositories_1.markMessagesAsCompacted)(messageIds, compactedSessionId);
            logger_1.log.info(traceId, "compaction.completed", {
                chatId,
                sessionId,
                compactedCount: messageIds.length,
            });
        }
        catch (err) {
            logger_1.log.error(traceId, "compaction.failed", { error: err });
            throw err;
        }
    }
}
exports.Compactor = Compactor;
