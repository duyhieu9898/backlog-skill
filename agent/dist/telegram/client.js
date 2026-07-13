"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramClient = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
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
    async sendArtifact(chatId, artifact, caption) {
        const method = artifact.mime_type.startsWith("image/") ? "sendPhoto" : "sendDocument";
        const field = method === "sendPhoto" ? "photo" : "document";
        const form = new FormData();
        form.set("chat_id", chatId);
        if (caption)
            form.set("caption", caption);
        const extension = artifact.mime_type === "image/png" ? ".png" : artifact.mime_type === "image/jpeg" ? ".jpg" : artifact.mime_type === "application/pdf" ? ".pdf" : ".txt";
        form.set(field, new Blob([node_fs_1.default.readFileSync(artifact.local_path)], { type: artifact.mime_type }), `${artifact.id}${extension}`);
        const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, { method: "POST", body: form });
        const body = (await response.json());
        if (!response.ok || !body.ok)
            throw new Error(`Telegram ${method} failed: ${response.status} ${body.description || ""}`.trim());
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
