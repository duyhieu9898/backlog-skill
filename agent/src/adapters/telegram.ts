import { generateTraceId } from "../logging/trace";
import type { TelegramUpdate } from "../telegram/client";
import type { StandardMessage } from "../types/messages";

export function toStandardMessage(update: TelegramUpdate): StandardMessage | null {
  const message = update.message;
  const chatId = String(message?.chat?.id || "");
  const userId = String(message?.from?.id || message?.chat?.id || "");
  const text = message?.text || "";
  if (!chatId || !text) return null;

  return {
    traceId: generateTraceId(),
    provider: "telegram",
    chatId,
    userId,
    text,
    timestamp: new Date((message?.date || Math.floor(Date.now() / 1000)) * 1000),
  };
}
