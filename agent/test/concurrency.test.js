// Proves ADR 0017 P2.3: per-session concurrency is serialized by Router's
// `chatLocks`. Two messages in the same chat run their tool loops one after
// another (never overlapping); two messages in different chats overlap. `/stop`
// bypasses the lock elsewhere — this test covers the normal serialization path.
//
// `paths.ts` resolves `sqliteFile` at module-eval time, so AGENT_DB_FILE must be
// set before any dist require. Each test file runs in its own subprocess.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrency-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { closeDb } = require("../dist/storage/db");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const skillsPath = path.join(__dirname, "..", "..", "skills");

// A stand-in tool loop whose run() measures how many runs overlap in time.
// Router hands it to AgentRuntime, so runtime.runAgent() calls loop.run().
function makeCountingLoop() {
  let active = 0;
  let maxActive = 0;
  return {
    maxActive: () => maxActive,
    async run() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return "ok";
    },
    async consumeScopedApproval() {
      return null;
    },
  };
}

function message(text, chatId, traceId) {
  return {
    traceId,
    provider: "telegram",
    chatId,
    userId: "user",
    text,
    timestamp: new Date(),
  };
}

test("same-chat messages are serialized — no two tool loops overlap", async () => {
  const loop = makeCountingLoop();
  const router = new Router(new SkillRegistry(skillsPath), loop);
  const chat = `same-chat-${Date.now()}`;

  const [r1, r2] = await Promise.all([
    router.route(message("first task", chat, `${chat}-1`)),
    router.route(message("second task", chat, `${chat}-2`)),
  ]);

  assert.equal(r1, "ok");
  assert.equal(r2, "ok");
  assert.equal(loop.maxActive(), 1, "same-chat runs must not overlap");
});

test("different-chat messages run concurrently", async () => {
  const loop = makeCountingLoop();
  const router = new Router(new SkillRegistry(skillsPath), loop);
  const a = `chat-a-${Date.now()}`;
  const b = `chat-b-${Date.now()}`;

  await Promise.all([
    router.route(message("task A", a, `${a}-1`)),
    router.route(message("task B", b, `${b}-1`)),
  ]);

  assert.equal(loop.maxActive(), 2, "different-chat runs should overlap");
});
