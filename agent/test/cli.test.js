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
const { listRecentChat } = require("../dist/storage/repositories");
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
