// Proves ADR 0017 P2.3: a run that exceeds `runtime.runDeadlineMs` is aborted
// via the AgentRuntime-owned AbortSignal and terminally recorded as `cancelled`.
// The deadline previously had no test at all.
//
// `paths.ts` resolves `configFile` at module-eval time, so AGENT_CONFIG_FILE
// (and AGENT_DB_FILE) must be set before any dist require. Each test file runs
// in its own subprocess.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// A short deadline, configured BEFORE dist requires.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-deadline-cfg-"));
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ runtime: { runDeadlineMs: 100 } }));
process.env.AGENT_CONFIG_FILE = path.join(configDir, "config.json");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-deadline-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { closeDb } = require("../dist/storage/db");
const { getRun } = require("../dist/storage/repositories");
const { AgentRuntime } = require("../dist/runtime/agentRuntime");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("a run exceeding runDeadlineMs is aborted and recorded as cancelled", async () => {
  const runtime = new AgentRuntime();
  const traceId = `run-deadline-${Date.now()}`;
  const message = {
    traceId,
    provider: "cli",
    chatId: `run-deadline-chat-${Date.now()}`,
    userId: "owner",
    text: "run a long local command",
    timestamp: new Date(),
  };
  const action = {
    name: "test.run-deadline",
    label: "Run deadline test",
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    requiresConfirmation: false,
  };

  const start = Date.now();
  const reply = await runtime.execute(message, async (signal) => {
    const result = await runtime.runCommand(action, {
      runId: traceId,
      traceId,
      chatId: message.chatId,
      signal,
      userIntent: message.text,
    });
    return result.summary;
  });
  const elapsed = Date.now() - start;

  assert.equal(reply, "Run cancelled.");
  assert.equal(getRun(traceId).status, "cancelled");
  // Guards against the config override silently failing and the 30min default
  // firing instead: the abort must land near the 100ms deadline.
  assert.ok(elapsed < 5000, `run should abort near the 100ms deadline, took ${elapsed}ms`);
});
