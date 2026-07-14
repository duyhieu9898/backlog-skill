"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const telegram_1 = require("./adapters/telegram");
const env_1 = require("./config/env");
const paths_1 = require("./config/paths");
const router_1 = require("./core/router");
const presenter_1 = require("./core/presenter");
const repositories_1 = require("./storage/repositories");
const logger_1 = require("./logging/logger");
const trace_1 = require("./logging/trace");
const registry_1 = require("./skills/registry");
const state_1 = require("./state");
const client_1 = require("./telegram/client");
const config_1 = require("./telegram/config");
const utils_1 = require("./utils");
const app_1 = require("./config/app");
const scheduler_1 = require("./scheduler");
const browser_service_1 = require("./browser/browser-service");
(0, env_1.loadEnv)(node_path_1.default.join(paths_1.agentDir, ".env"));
const telegramConfig = (0, config_1.loadTelegramConfig)();
const telegram = new client_1.TelegramClient(telegramConfig);
const skills = new registry_1.SkillRegistry();
const router = new router_1.Router(skills);
const agentConfig = (0, app_1.loadAgentConfig)();
async function initializeOffset() {
    const updates = await telegram.getUpdates(null, 0);
    const offset = updates.length ? updates[updates.length - 1].update_id + 1 : 0;
    (0, state_1.writeOffset)(offset);
    console.log(`Initialized Telegram offset at ${offset}. Old messages were skipped.`);
    return offset;
}
let globalScheduledRunner = null;
async function poll() {
    let offset = (0, state_1.readOffset)();
    console.log("Agent started with an allowlisted Telegram chat.");
    try {
        await telegram.deleteWebhook();
        console.log("Deleted active webhook (if any) to enable polling.");
    }
    catch (error) {
        console.error("Failed to delete webhook:", error);
    }
    if (offset === null) {
        offset = await initializeOffset();
    }
    (0, scheduler_1.seedScheduledJobsFromConfig)(agentConfig.schedules || []);
    globalScheduledRunner = new scheduler_1.ScheduledCheckRunner(telegramConfig.allowedChatId, (text) => telegram.sendMessage(telegramConfig.allowedChatId, text), agentConfig.runtime?.commandTimeoutMs);
    globalScheduledRunner.start();
    while (true) {
        try {
            const updates = await telegram.getUpdates(offset, telegramConfig.pollTimeoutSeconds);
            for (const update of updates) {
                offset = update.update_id + 1;
                (0, state_1.writeOffset)(offset);
                const standard = (0, telegram_1.toStandardMessage)(update);
                if (!standard)
                    continue;
                if (standard.userId !== telegramConfig.allowedUserId || standard.chatId !== telegramConfig.allowedChatId) {
                    logger_1.log.warn(standard.traceId, "message.rejected", { userId: standard.userId, chatId: standard.chatId });
                    continue;
                }
                if (update.callback_query) {
                    telegram.answerCallbackQuery(update.callback_query.id, "Đang xử lý...").catch((e) => {
                        logger_1.log.error(standard.traceId, "telegram.answerCallbackQuery.failed", { error: e });
                    });
                    const callbackMessage = update.callback_query.message;
                    if (callbackMessage?.chat?.id !== undefined && typeof callbackMessage.message_id === "number") {
                        telegram.clearInlineKeyboard(String(callbackMessage.chat.id), callbackMessage.message_id).catch((e) => {
                            logger_1.log.error(standard.traceId, "telegram.clearInlineKeyboard.failed", { error: e });
                        });
                    }
                }
                const typingInterval = setInterval(() => {
                    telegram.sendChatAction(standard.chatId, "typing").catch(() => { });
                }, 4000);
                telegram.sendChatAction(standard.chatId, "typing").catch(() => { });
                let replyMarkup;
                let artifactId;
                router
                    .route(standard, (markup) => {
                    replyMarkup = markup;
                }, (id) => { artifactId = id; })
                    .then(async (reply) => {
                    clearInterval(typingInterval);
                    logger_1.log.info(standard.traceId, "telegram.reply.started", {
                        hasReplyMarkup: replyMarkup !== undefined,
                        replyMarkup: replyMarkup ?? null,
                    });
                    const artifact = artifactId ? (0, repositories_1.getArtifact)(artifactId) : null;
                    await (0, presenter_1.deliverResponse)(telegram, standard.chatId, artifact ? { text: reply, artifact } : { text: reply }, replyMarkup);
                    logger_1.log.info(standard.traceId, "telegram.reply.completed", {});
                })
                    .catch(async (error) => {
                    clearInterval(typingInterval);
                    const messageText = error instanceof Error ? error.message : String(error);
                    logger_1.log.error(standard.traceId, "telegram.reply.failed", { error });
                    await telegram.sendMessage(standard.chatId, `Agent lỗi\ntraceId: ${standard.traceId}\n\n${messageText}`);
                });
            }
        }
        catch (error) {
            const traceId = (0, trace_1.generateTraceId)();
            const messageText = error instanceof Error ? error.message : String(error);
            logger_1.log.error(traceId, "telegram.reply.failed", { error });
            console.error(`[${(0, utils_1.formatDate)()}] ${messageText}`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}
poll();
let shutdownStarted = false;
async function handleShutdown(signal) {
    if (shutdownStarted)
        return;
    shutdownStarted = true;
    logger_1.log.info("system-shutdown", "bot.shutdown.started", { signal });
    console.log(`\nReceived ${signal}, initiating graceful shutdown...`);
    try {
        if (globalScheduledRunner) {
            globalScheduledRunner.stop();
        }
        const result = await browser_service_1.browserService.shutdown();
        logger_1.log.info("system-shutdown", "bot.shutdown.completed", result);
        console.log("Graceful shutdown completed successfully.");
        process.exit(0);
    }
    catch (error) {
        logger_1.log.error("system-shutdown", "bot.shutdown.failed", { error });
        console.error("Graceful shutdown failed:", error);
        process.exit(1);
    }
}
process.once("SIGTERM", () => {
    void handleShutdown("SIGTERM");
});
process.once("SIGINT", () => {
    void handleShutdown("SIGINT");
});
