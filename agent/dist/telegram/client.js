"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramClient = void 0;
class TelegramClient {
    config;
    constructor(config) {
        this.config = config;
    }
    async sendMessage(chatId, text) {
        for (const chunk of splitTelegramText(text)) {
            await this.request("sendMessage", {
                chat_id: chatId,
                text: chunk,
                disable_web_page_preview: true,
            });
        }
    }
    async getUpdates(offset, timeout) {
        const result = await this.request("getUpdates", {
            offset: offset ?? undefined,
            timeout,
            allowed_updates: ["message"],
        });
        return result || [];
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
