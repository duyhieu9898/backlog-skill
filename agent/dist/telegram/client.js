"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramClient = void 0;
class TelegramClient {
    config;
    constructor(config) {
        this.config = config;
    }
    async deleteWebhook() {
        await this.request("deleteWebhook", {});
    }
    async sendMessage(chatId, text, replyMarkup) {
        const chunks = splitTelegramText(text);
        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            await this.request("sendMessage", {
                chat_id: chatId,
                text: chunks[i],
                disable_web_page_preview: true,
                reply_markup: isLast ? replyMarkup : undefined,
            });
        }
    }
    async getUpdates(offset, timeout) {
        const result = await this.request("getUpdates", {
            offset: offset ?? undefined,
            timeout,
            allowed_updates: ["message", "callback_query"],
        });
        return result || [];
    }
    async answerCallbackQuery(callbackQueryId, text) {
        await this.request("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text,
        });
    }
    async sendChatAction(chatId, action = "typing") {
        await this.request("sendChatAction", {
            chat_id: chatId,
            action,
        });
    }
    async request(method, payload) {
        const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const body = (await response.json());
        if (!response.ok || !body.ok) {
            throw new Error(`Telegram ${method} failed: ${response.status} ${body.description || ""}`.trim());
        }
        return body.result;
    }
}
exports.TelegramClient = TelegramClient;
function splitTelegramText(text) {
    const limit = 3500;
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > limit) {
        const cut = remaining.lastIndexOf("\n", limit);
        const size = cut > 500 ? cut : limit;
        chunks.push(remaining.slice(0, size));
        remaining = remaining.slice(size).trimStart();
    }
    if (remaining)
        chunks.push(remaining);
    return chunks;
}
