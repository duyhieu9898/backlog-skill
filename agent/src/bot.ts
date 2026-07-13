import path from "node:path";

import { toStandardMessage } from "./adapters/telegram";
import { loadEnv } from "./config/env";
import { agentDir } from "./config/paths";
import { Router } from "./core/router";
import { deliverResponse } from "./core/presenter";
import { getArtifact } from "./storage/repositories";
import { log } from "./logging/logger";
import { generateTraceId } from "./logging/trace";
import { SkillRegistry } from "./skills/registry";
import { readOffset, writeOffset } from "./state";
import { TelegramClient } from "./telegram/client";
import { loadTelegramConfig } from "./telegram/config";
import { formatDate } from "./utils";
import { loadAgentConfig } from "./config/app";
import { seedScheduledJobsFromConfig, ScheduledCheckRunner } from "./scheduler";

loadEnv(path.join(agentDir, ".env"));

const telegramConfig = loadTelegramConfig();
const telegram = new TelegramClient(telegramConfig);
const skills = new SkillRegistry();
const router = new Router(skills);
const agentConfig = loadAgentConfig();

async function initializeOffset(): Promise<number> {
  const updates = await telegram.getUpdates(null, 0);
  const offset = updates.length ? updates[updates.length - 1].update_id + 1 : 0;
  writeOffset(offset);
  console.log(`Initialized Telegram offset at ${offset}. Old messages were skipped.`);
  return offset;
}

async function poll(): Promise<void> {
  let offset = readOffset();
  console.log("Agent started with an allowlisted Telegram chat.");

  try {
    await telegram.deleteWebhook();
    console.log("Deleted active webhook (if any) to enable polling.");
  } catch (error) {
    console.error("Failed to delete webhook:", error);
  }

  if (offset === null) {
    offset = await initializeOffset();
  }

  seedScheduledJobsFromConfig(agentConfig.schedules || []);
  const scheduledRunner = new ScheduledCheckRunner(
    telegramConfig.allowedChatId,
    (text) => telegram.sendMessage(telegramConfig.allowedChatId, text),
    agentConfig.runtime?.commandTimeoutMs,
  );
  scheduledRunner.start();

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset, telegramConfig.pollTimeoutSeconds);

      for (const update of updates) {
        offset = update.update_id + 1;
        writeOffset(offset);

        const standard = toStandardMessage(update);
        if (!standard) continue;

        if (standard.userId !== telegramConfig.allowedUserId || standard.chatId !== telegramConfig.allowedChatId) {
          log.warn(standard.traceId, "message.rejected", { userId: standard.userId, chatId: standard.chatId });
          continue;
        }

        if (update.callback_query) {
          telegram.answerCallbackQuery(update.callback_query.id, "Đang xử lý...").catch((e) => {
            log.error(standard.traceId, "telegram.answerCallbackQuery.failed", { error: e });
          });
          const callbackMessage = update.callback_query.message;
          if (callbackMessage?.chat?.id !== undefined && typeof callbackMessage.message_id === "number") {
            telegram.clearInlineKeyboard(String(callbackMessage.chat.id), callbackMessage.message_id).catch((e) => {
              log.error(standard.traceId, "telegram.clearInlineKeyboard.failed", { error: e });
            });
          }
        }

        const typingInterval = setInterval(() => {
          telegram.sendChatAction(standard.chatId, "typing").catch(() => {});
        }, 4000);
        telegram.sendChatAction(standard.chatId, "typing").catch(() => {});

        let replyMarkup: unknown;
        let artifactId: string | undefined;
        router
          .route(standard, (markup) => {
            replyMarkup = markup;
          }, (id) => { artifactId = id; })
          .then(async (reply) => {
            clearInterval(typingInterval);
            log.info(standard.traceId, "telegram.reply.started", {
              hasReplyMarkup: replyMarkup !== undefined,
              replyMarkup: replyMarkup ?? null,
            });
            const artifact = artifactId ? getArtifact(artifactId) : null;
            await deliverResponse(telegram, standard.chatId, artifact ? { text: reply, artifact } : { text: reply }, replyMarkup);
            log.info(standard.traceId, "telegram.reply.completed", {});
          })
          .catch(async (error: unknown) => {
            clearInterval(typingInterval);
            const messageText = error instanceof Error ? error.message : String(error);
            log.error(standard.traceId, "telegram.reply.failed", { error });
            await telegram.sendMessage(standard.chatId, `Agent lỗi\ntraceId: ${standard.traceId}\n\n${messageText}`);
          });
      }
    } catch (error) {
      const traceId = generateTraceId();
      const messageText = error instanceof Error ? error.message : String(error);
      log.error(traceId, "telegram.reply.failed", { error });
      console.error(`[${formatDate()}] ${messageText}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

poll();
