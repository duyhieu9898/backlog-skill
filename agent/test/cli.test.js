const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  inputFromArgs,
  LOCAL_CLI_CHAT_ID,
  LOCAL_CLI_USER_ID,
  toCliMessage,
} = require("../dist/adapters/cli");
const {
  listRecentChat,
  resetSession,
  insertChatMessage,
  getUncompactedChatMessages,
} = require("../dist/storage/repositories");
const {
  commandPreviewDigest,
  previewCommand,
} = require("../dist/commands");
const {
  deletePendingConfirmation,
  getPendingConfirmation,
  upsertPendingConfirmation,
} = require("../dist/storage/repositories");

const agentDir = path.join(__dirname, "..");
const cliPath = path.join(agentDir, "dist", "cli.js");

test("CLI adapter creates a stable local Router message", () => {
  const message = toCliMessage("/status");

  assert.equal(message.provider, "cli");
  assert.equal(message.chatId, LOCAL_CLI_CHAT_ID);
  assert.equal(message.userId, LOCAL_CLI_USER_ID);
  assert.equal(message.text, "/status");
  assert.ok(message.traceId.startsWith("tr_"));
  assert.equal(inputFromArgs(["hello", "local", "operator"]), "hello local operator");
});

test("CLI routes argv input through Router and persists the local chat", () => {
  const output = execFileSync(process.execPath, [cliPath, "/status"], {
    cwd: agentDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(output, /uptime:/);
  const messages = listRecentChat(LOCAL_CLI_CHAT_ID, 2);
  assert.equal(messages.at(-2)?.content, "/status");
  assert.match(messages.at(-1)?.content || "", /uptime:/);
});

test("CLI accepts stdin input without starting Telegram", () => {
  const output = execFileSync(process.execPath, [cliPath], {
    cwd: agentDir,
    encoding: "utf8",
    input: "/commands\n",
    stdio: ["pipe", "pipe", "pipe"],
  });

  assert.match(output, /bemo\.checkout/);
});

test("CLI confirms a digest-bound harmless command from a prior local invocation", () => {
  const action = {
    name: "test.cli-confirm",
    label: "CLI confirmation test",
    argv: [process.execPath, "-e", 'process.stdout.write("cli-confirmed")'],
    requiresConfirmation: true,
  };
  const preview = previewCommand(action);
  const digest = commandPreviewDigest(preview);
  upsertPendingConfirmation({
    chatId: LOCAL_CLI_CHAT_ID,
    traceId: `test-cli-pending-${Date.now()}`,
    commandName: action.name,
    payload: { action, preview, digest },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  try {
    const output = execFileSync(
      process.execPath,
      [cliPath, `confirm ${action.name} ${digest.slice(0, 12)}`],
      { cwd: agentDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.match(output, /cli-confirmed/);
    assert.equal(getPendingConfirmation(LOCAL_CLI_CHAT_ID), null);
  } finally {
    deletePendingConfirmation(LOCAL_CLI_CHAT_ID);
  }
});

test("CLI /reset command clears local chat history", () => {
  const output = execFileSync(
    process.execPath,
    [cliPath, "/reset"],
    { cwd: agentDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  assert.match(output, /Đã bắt đầu phiên trò chuyện mới/);
  const messages = listRecentChat(LOCAL_CLI_CHAT_ID, 10);
  // It should only contain 1 message (the assistant confirmation reply)
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Đã bắt đầu phiên trò chuyện mới/);
});

test("Compactor triggers compaction when session messages exceed 15", async () => {
  const { Compactor } = require("../dist/context/compactor");
  const compactor = new Compactor();
  const chatId = `compaction-test-${Date.now()}`;
  const sessionId = resetSession(chatId);

  // Insert 16 messages
  for (let i = 1; i <= 8; i++) {
    insertChatMessage({
      chatId,
      userId: "user",
      role: "user",
      content: `User message ${i}`,
      traceId: `tr_user_${i}`,
      sessionId,
    });
    insertChatMessage({
      chatId,
      userId: "agent",
      role: "assistant",
      content: `Assistant reply ${i}`,
      traceId: `tr_agent_${i}`,
      sessionId,
    });
  }

  // Trigger compaction
  await compactor.compactIfNeeded(chatId);

  // The first 10 messages should be compacted (their session_id changed to sessionId:compacted)
  // There should be 16 - 10 = 6 messages left, plus 1 system summary message = 7 messages
  const remaining = getUncompactedChatMessages(chatId, sessionId);
  assert.equal(remaining.length, 7);

  // The first message of the remaining list should be the system summary
  assert.equal(remaining[0].role, "system");
  assert.match(remaining[0].content, /Bản tóm tắt lịch sử cuộc trò chuyện cũ:/);

  // The rest of the messages should be the last 6 messages
  assert.equal(remaining[1].content, "User message 6");
  assert.equal(remaining[6].content, "Assistant reply 8");
});

test("Compactor prevents concurrent compaction calls for the same chatId", async () => {
  const { Compactor } = require("../dist/context/compactor");
  const compactor = new Compactor();
  const chatId = `compaction-lock-test-${Date.now()}`;
  const sessionId = resetSession(chatId);

  // Insert 16 messages
  for (let i = 1; i <= 8; i++) {
    insertChatMessage({ chatId, userId: "user", role: "user", content: `Msg ${i}`, traceId: `tr_u_${i}`, sessionId });
    insertChatMessage({ chatId, userId: "agent", role: "assistant", content: `Reply ${i}`, traceId: `tr_a_${i}`, sessionId });
  }

  // Trigger compaction concurrently
  const p1 = compactor.compactIfNeeded(chatId);
  const p2 = compactor.compactIfNeeded(chatId);
  await Promise.all([p1, p2]);

  // If both compactions ran, we would have two system summary messages.
  // Since lock is working, only one compaction runs, so we should have exactly 1 system summary message.
  const remaining = getUncompactedChatMessages(chatId, sessionId);
  const summaries = remaining.filter((m) => m.role === "system");
  assert.equal(summaries.length, 1);
});


