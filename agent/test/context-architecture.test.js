const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const { ContextHydrator } = require("../dist/context/hydrator");
const { SkillRegistry } = require("../dist/skills/registry");
const { loadSystemPrompt } = require("../dist/config/app");
const { memoryFile } = require("../dist/config/paths");
const { flushCheckpointToDailyMemory } = require("../dist/context/memory");
const {
  appendRunStep,
  createRun,
  insertChatMessage,
  saveContextCheckpoint,
} = require("../dist/storage/repositories");

test("working context retains a past tool call and result as one pruned atomic block", () => {
  const chatId = `context-tool-pair-${Date.now()}`;
  const runId = `context-tool-run-${Date.now()}`;
  insertChatMessage({ chatId, userId: "user", role: "user", content: "read the large log", traceId: runId });
  createRun({ id: runId, session_id: "default", principal_id: "user", channel: "telegram", user_request: "read the large log", trace_id: runId });
  appendRunStep({
    runId,
    toolName: "file.read",
    call: { name: "file.read", arguments: { path: "/tmp/log.txt" } },
    result: { ok: true, output: `begin-${"x".repeat(5000)}-end` },
  });
  insertChatMessage({ chatId, userId: "agent", role: "assistant", content: "I inspected the log.", traceId: runId });

  const prompt = new ContextHydrator(new SkillRegistry(path.join(__dirname, "..", "..", "skills"))).hydrate({
    traceId: `context-tool-now-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "user",
    text: "what did the log say?",
    timestamp: new Date(),
  }).prompt;
  const block = prompt.history.find((entry) => entry.content.includes("[TOOL CALL]"));
  assert.ok(block);
  assert.match(block.content, /file\.read/);
  assert.match(block.content, /\[TOOL RESULT\]/);
  assert.match(block.content, /old tool result trimmed/);
  assert.match(block.content, /begin-/);
  assert.match(block.content, /-end/);
});

test("working context receives a persisted checkpoint while raw transcript stays durable", () => {
  const chatId = `context-checkpoint-${Date.now()}`;
  const oldTrace = `context-old-${Date.now()}`;
  insertChatMessage({ chatId, userId: "user", role: "user", content: "old transcript detail", traceId: oldTrace });
  saveContextCheckpoint({
    chatId,
    sessionId: "default",
    checkpoint: {
      goals: ["continue migration"], constraints: [], completed: ["saved old transcript"], inProgress: [], blockers: [],
      decisions: [{ decision: "use token budget" }], nextSteps: ["verify prompt"], criticalContext: [], importantIdentifiers: [],
    },
    firstKeptMessageId: 1,
    tokensBefore: 999,
  });
  const prompt = new ContextHydrator(new SkillRegistry(path.join(__dirname, "..", "..", "skills"))).hydrate({
    traceId: `context-checkpoint-now-${Date.now()}`, provider: "telegram", chatId, userId: "user", text: "continue", timestamp: new Date(),
  }).prompt;
  assert.match(prompt.history[0].content, /\[SESSION CHECKPOINT\]/);
  assert.match(prompt.history[0].content, /continue migration/);
  assert.match(prompt.history.map((entry) => entry.content).join("\n"), /old transcript detail/);
});

test("system prompt does not wholesale-inject curated durable memory", () => {
  const memory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, "utf8").trim() : "";
  if (!memory) return;
  const distinctiveLine = memory.split("\n").find((line) => line.trim() && !line.startsWith("#"));
  if (distinctiveLine) assert.doesNotMatch(loadSystemPrompt(), new RegExp(distinctiveLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("pre-compaction flush writes daily working memory without changing curated MEMORY.md", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = flushCheckpointToDailyMemory({
    goals: [], constraints: [], completed: [], inProgress: [], blockers: [],
    decisions: [{ decision: "keep checkpoint", rationale: "audit" }], nextSteps: [], criticalContext: ["old facts"], importantIdentifiers: ["US-CTX"],
  }, new Date("2026-07-17T10:00:00.000Z"), dir);
  assert.equal(file, path.join(dir, "2026-07-17.md"));
  assert.match(fs.readFileSync(file, "utf8"), /keep checkpoint/);
  assert.match(fs.readFileSync(file, "utf8"), /US-CTX/);
});
