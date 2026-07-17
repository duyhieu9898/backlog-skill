const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const {
  inputFromArgs,
  cliChatId,
  LOCAL_CLI_CHAT_ID,
  LOCAL_CLI_USER_ID,
  toCliMessage,
} = require("../dist/adapters/cli");
const {
  listRecentChat,
  resetSession,
  insertChatMessage,
  getContextCheckpoint,
  getUncompactedChatMessages,
  getPendingApproval,
} = require("../dist/storage/repositories");
const {
  commandPreviewDigest,
  previewCommand,
} = require("../dist/commands");
const { ApprovalService } = require("../dist/security/approvalService");

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

test("CLI adapter isolates an explicitly named session without changing the stable default", () => {
  assert.equal(cliChatId(), LOCAL_CLI_CHAT_ID);
  assert.equal(cliChatId("eval-case-a"), "local-cli:session:eval-case-a");
  assert.equal(toCliMessage("2+2", { session: "eval-case-a" }).chatId, "local-cli:session:eval-case-a");
  assert.throws(() => cliChatId(" "), /must not be empty/);
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

test("CLI --session keeps independent history out of the default local chat", () => {
  const session = `isolated-${Date.now()}`;
  const output = execFileSync(process.execPath, [cliPath, "--session", session, "/status"], {
    cwd: agentDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /uptime:/);
  const isolatedMessages = listRecentChat(cliChatId(session), 2);
  assert.equal(isolatedMessages.at(-2)?.content, "/status");
  const defaultMessages = listRecentChat(LOCAL_CLI_CHAT_ID, 20);
  assert.ok(!defaultMessages.some((message) => message.content === "/status" && message.created_at === isolatedMessages.at(-2)?.created_at));
});

test("CLI approves a digest-bound harmless command from a prior local invocation", () => {
  const action = {
    name: "test.cli-confirm",
    label: "CLI confirmation test",
    argv: [process.execPath, "-e", 'process.stdout.write("cli-confirmed")'],
    requiresConfirmation: true,
  };
  const preview = previewCommand(action);
  const digest = commandPreviewDigest(preview);
  const pending = new ApprovalService().create({ runId: `test-cli-pending-${Date.now()}`, principalId: LOCAL_CLI_USER_ID, chatId: LOCAL_CLI_CHAT_ID, description: "CLI confirmation test.", actionDigest: digest, payload: { action, preview }, expiresAt: new Date(Date.now() + 120000).toISOString() });
  const output = execFileSync(
    process.execPath,
    [cliPath, `approve ${pending.short_id}`],
    { cwd: agentDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(output, /cli-confirmed/);
  assert.equal(getPendingApproval(pending.short_id, LOCAL_CLI_USER_ID, LOCAL_CLI_CHAT_ID)?.status, "approved");
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
  const compactor = new Compactor({ recentTailTokens: 50 });
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

  // Old entries are retained durably under the compacted session marker. The
  // active view gets a separate structured checkpoint instead of a synthetic
  // chat row that would be mistaken for raw conversation.
  const remaining = getUncompactedChatMessages(chatId, sessionId);
  assert.ok(remaining.length > 0 && remaining.length < 16);
  assert.ok(remaining.every((message) => message.role !== "system"));
  const checkpoint = getContextCheckpoint(chatId, sessionId);
  assert.ok(checkpoint);
  assert.equal(checkpoint.compaction_count, 1);
  assert.ok(checkpoint.first_kept_message_id);
  assert.ok(checkpoint.tokens_before > 50);
});

test("Compactor prevents concurrent compaction calls for the same chatId", async () => {
  const { Compactor } = require("../dist/context/compactor");
  const compactor = new Compactor({ recentTailTokens: 50 });
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

  // If both compactions ran, the persisted checkpoint revision would be 2.
  assert.equal(getContextCheckpoint(chatId, sessionId)?.compaction_count, 1);
});
