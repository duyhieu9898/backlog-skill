const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTelegramConfig } = require("../dist/telegram/config");

test("Telegram config requires token and allowed chat ID", () => {
  assert.throws(() => loadTelegramConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(
    () => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "token" }),
    /TELEGRAM_CHAT_ID/,
  );
});

test("Telegram config validates and returns explicit environment values", () => {
  assert.deepEqual(
    loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "1234",
      TELEGRAM_POLL_TIMEOUT: "30",
    }),
    {
      botToken: "token",
      allowedChatId: "1234",
      pollTimeoutSeconds: 30,
    },
  );
  assert.throws(
    () => loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "1234",
      TELEGRAM_POLL_TIMEOUT: "60",
    }),
    /between 0 and 50/,
  );
});
