import path from "node:path";

import { toStandardMessage } from "./adapters/telegram";
import { loadEnv } from "./config/env";
import { agentDir } from "./config/paths";
import { Router } from "./core/router";
import { log } from "./logging/logger";
import { generateTraceId } from "./logging/trace";
import { SkillRegistry } from "./skills/registry";
import { readOffset, writeOffset } from "./state";
import { TelegramClient } from "./telegram/client";
import { loadTelegramConfig } from "./telegram/config";
import { formatDate } from "./utils";

loadEnv(path.join(agentDir, ".env"));

const telegramConfig = loadTelegramConfig();
const telegram = new TelegramClient(telegramConfig);
const skills = new SkillRegistry();
const router = new Router(skills);

async function initializeOffset(): Promise<number> {
  const updates = await telegram.getUpdates(null, 0);
  const offset = updates.length ? updates[updates.length - 1].update_id + 1 : 0;
  writeOffset(offset);
  console.log(`Initialized Telegram offset at ${offset}. Old messages were skipped.`);
  return offset;
}

async function poll(): Promise<void> {
  let offset = readOffset();
  console.log(`Agent started. Allowed chat id: ${telegramConfig.allowedChatId}`);

  try {
    await telegram.deleteWebhook();
    console.log("Deleted active webhook (if any) to enable polling.");
  } catch (error) {
    console.error("Failed to delete webhook:", error);
  }

  if (offset === null) {
    offset = await initializeOffset();
  }

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset, telegramConfig.pollTimeoutSeconds);

      for (const update of updates) {
        offset = update.update_id + 1;
        writeOffset(offset);

        const standard = toStandardMessage(update);
        if (!standard) continue;

        if (standard.chatId !== telegramConfig.allowedChatId) {
          log.warn(standard.traceId, "message.rejected", { chatId: standard.chatId });
          await telegram.sendMessage(standard.chatId, "không có quyền");
          continue;
        }

        log.info(standard.traceId, "message.received", { adapter: "telegram" });
        router
          .route(standard)
          .then(async (reply) => {
            log.info(standard.traceId, "telegram.reply.started", {});
            await telegram.sendMessage(standard.chatId, reply);
            log.info(standard.traceId, "telegram.reply.completed", {});
          })
          .catch(async (error: unknown) => {
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
