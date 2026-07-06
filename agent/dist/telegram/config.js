"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadTelegramConfig = loadTelegramConfig;
function requiredEnv(env, key) {
    const value = env[key]?.trim();
    if (!value)
        throw new Error(`Missing required environment variable: ${key}`);
    return value;
}
function loadTelegramConfig(env = process.env) {
    const pollTimeoutSeconds = Number(env.TELEGRAM_POLL_TIMEOUT || 25);
    if (!Number.isInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 0 || pollTimeoutSeconds > 50) {
        throw new Error("TELEGRAM_POLL_TIMEOUT must be an integer between 0 and 50.");
    }
    return {
        botToken: requiredEnv(env, "TELEGRAM_BOT_TOKEN"),
        allowedChatId: requiredEnv(env, "TELEGRAM_CHAT_ID"),
        pollTimeoutSeconds,
    };
}
