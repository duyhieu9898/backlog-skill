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
const logger_1 = require("./logging/logger");
const trace_1 = require("./logging/trace");
const registry_1 = require("./skills/registry");
const state_1 = require("./state");
const client_1 = require("./telegram/client");
const config_1 = require("./telegram/config");
const utils_1 = require("./utils");
const app_1 = require("./config/app");
const scheduler_1 = require("./scheduler");
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
    const scheduledRunner = new scheduler_1.ScheduledCheckRunner(telegramConfig.allowedChatId, (text) => telegram.sendMessage(telegramConfig.allowedChatId, text), agentConfig.runtime?.commandTimeoutMs);
    scheduledRunner.start();
    while (true) {
        try {
            const updates = await telegram.getUpdates(offset, telegramConfig.pollTimeoutSeconds);
            for (const update of updates) {
                offset = update.update_id + 1;
                (0, state_1.writeOffset)(offset);
                const standard = (0, telegram_1.toStandardMessage)(update);
                if (!standard)
                    continue;
                if (standard.chatId !== telegramConfig.allowedChatId) {
                    logger_1.log.warn(standard.traceId, "message.rejected", { chatId: standard.chatId });
                    await telegram.sendMessage(standard.chatId, "không có quyền");
                    continue;
                }
                if (update.callback_query) {
                    telegram.answerCallbackQuery(update.callback_query.id, "Đang xử lý...").catch((e) => {
                        logger_1.log.error(standard.traceId, "telegram.answerCallbackQuery.failed", { error: e });
                    });
                }
                const typingInterval = setInterval(() => {
                    telegram.sendChatAction(standard.chatId, "typing").catch(() => { });
                }, 4000);
                telegram.sendChatAction(standard.chatId, "typing").catch(() => { });
                let replyMarkup;
                router
                    .route(standard, (markup) => {
                    replyMarkup = markup;
                })
                    .then(async (reply) => {
                    clearInterval(typingInterval);
                    logger_1.log.info(standard.traceId, "telegram.reply.started", {
                        hasReplyMarkup: replyMarkup !== undefined,
                        replyMarkup: replyMarkup ?? null,
                    });
                    await telegram.sendMessage(standard.chatId, reply, replyMarkup);
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
