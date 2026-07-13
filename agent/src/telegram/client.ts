import fs from "node:fs";

import type { TelegramConfig } from "./config";
import type { Artifact } from "../artifacts/store";

export type TelegramMessage = {
  chat?: { id?: number | string };
  message_id?: number;
  from?: { id?: number | string };
  text?: string;
  date?: number;
};

export type TelegramCallbackQuery = {
  id: string;
  from: { id: number | string };
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

export class TelegramClient {
  constructor(private readonly config: TelegramConfig) {}

  async deleteWebhook(): Promise<void> {
    await this.request("deleteWebhook", {});
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
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

  async sendArtifact(chatId: string, artifact: Artifact, caption?: string): Promise<void> {
    const method = artifact.mime_type.startsWith("image/") ? "sendPhoto" : "sendDocument";
    const field = method === "sendPhoto" ? "photo" : "document";
    const form = new FormData();
    form.set("chat_id", chatId);
    if (caption) form.set("caption", caption);
    const extension = artifact.mime_type === "image/png" ? ".png" : artifact.mime_type === "image/jpeg" ? ".jpg" : artifact.mime_type === "application/pdf" ? ".pdf" : ".txt";
    form.set(field, new Blob([fs.readFileSync(artifact.local_path)], { type: artifact.mime_type }), `${artifact.id}${extension}`);
    const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, { method: "POST", body: form });
    const body = (await response.json()) as TelegramResponse<unknown>;
    if (!response.ok || !body.ok) throw new Error(`Telegram ${method} failed: ${response.status} ${body.description || ""}`.trim());
  }

  async getUpdates(offset: number | null, timeout: number): Promise<TelegramUpdate[]> {
    const result = await this.request<TelegramUpdate[]>("getUpdates", {
      offset: offset ?? undefined,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });

    return result || [];
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  /** Remove a consumed inline keyboard so its confirmation cannot be clicked again. */
  async clearInlineKeyboard(chatId: string, messageId: number): Promise<void> {
    await this.request("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  async sendChatAction(chatId: string, action: "typing" | "upload_document" = "typing"): Promise<void> {
    await this.request("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  private async request<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    const body = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !body.ok) {
      throw new Error(
        `Telegram ${method} failed: ${response.status} ${body.description || ""}`.trim(),
      );
    }

    return body.result as T;
  }
}

function splitTelegramText(text: string): string[] {
  const limit = 3500;
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const cut = remaining.lastIndexOf("\n", limit);
    const size = cut > 500 ? cut : limit;
    chunks.push(remaining.slice(0, size));
    remaining = remaining.slice(size).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
