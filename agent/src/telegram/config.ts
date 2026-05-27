export type TelegramConfig = {
  botToken: string;
  allowedChatId: string;
  pollTimeoutSeconds: number;
};

export function loadTelegramConfig(): TelegramConfig {
  return {
    botToken:
      process.env.TELEGRAM_BOT_TOKEN || "8556741894:AAFn29duC9iBGJMn7sBndtdkWKFzwQaey3o",
    allowedChatId: String(process.env.TELEGRAM_CHAT_ID || "811696951"),
    pollTimeoutSeconds: Number(process.env.TELEGRAM_POLL_TIMEOUT || 25),
  };
}
