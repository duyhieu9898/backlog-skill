const assert = require("node:assert/strict");
const test = require("node:test");

const { AgentRuntime } = require("../dist/runtime/agentRuntime");
const { getRun } = require("../dist/storage/repositories");

test("AgentRuntime aborts an active run through AbortSignal and persists cancellation", async () => {
  const runtime = new AgentRuntime();
  const traceId = `runtime-cancel-${Date.now()}`;
  const message = {
    traceId,
    provider: "cli",
    chatId: `runtime-cancel-chat-${Date.now()}`,
    userId: "owner",
    text: "run a long local command",
    timestamp: new Date(),
  };
  const action = {
    name: "test.runtime-cancel",
    label: "Runtime cancellation test",
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    requiresConfirmation: false,
  };

  const run = runtime.execute(message, async (signal) => {
    const result = await runtime.runCommand(action, {
      runId: traceId,
      traceId,
      chatId: message.chatId,
      signal,
      userIntent: message.text,
    });
    return result.summary;
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runtime.cancelActiveRun(message.chatId), traceId);
  assert.equal(await run, "Run cancelled.");
  assert.equal(getRun(traceId).status, "cancelled");
});
