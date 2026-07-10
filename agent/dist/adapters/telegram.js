"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toStandardMessage = toStandardMessage;
const trace_1 = require("../logging/trace");
function toStandardMessage(update) {
    if (update.callback_query) {
        const query = update.callback_query;
        const chatId = String(query.message?.chat?.id || query.from?.id || "");
        const userId = String(query.from?.id || "");
        const text = query.data || "";
        if (!chatId || !text)
            return null;
        return {
            traceId: (0, trace_1.generateTraceId)(),
            provider: "telegram",
            chatId,
            userId,
            text,
            timestamp: new Date(),
        };
    }
    const message = update.message;
    const chatId = String(message?.chat?.id || "");
    const userId = String(message?.from?.id || message?.chat?.id || "");
    const text = message?.text || "";
    if (!chatId || !text)
        return null;
    return {
        traceId: (0, trace_1.generateTraceId)(),
        provider: "telegram",
        chatId,
        userId,
        text,
        timestamp: new Date((message?.date || Math.floor(Date.now() / 1000)) * 1000),
    };
}
