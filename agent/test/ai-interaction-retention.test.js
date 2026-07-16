// Proves ADR 0017 P2.3: raw-AI interaction logging prunes directories older
// than the retention window. `appendRawAiInteraction` calls
// `pruneRawAiInteractions(retentionDays)` before every append, so an interaction
// directory dated outside the window is removed while today's is kept. This
// retention path previously had no test.
//
// `aiInteractionDir` is a fixed path (no env override), so this test touches the
// shared agent/logs/ai-interactions directory: it seeds an old dated dir, then
// cleans up only the file it wrote today (one appended index.jsonl line is a
// benign log entry that cannot be un- appended).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-retention-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { closeDb } = require("../dist/storage/db");
const { aiInteractionDir } = require("../dist/config/paths");
const { appendRawAiInteraction } = require("../dist/logging/aiInteractions");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const OLD_DATE = "2020-01-01";

test("appendRawAiInteraction prunes interaction dirs older than the retention window", () => {
  const oldDir = path.join(aiInteractionDir, OLD_DATE);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "keep.txt"), "old");
  assert.equal(fs.existsSync(oldDir), true);

  const traceId = `retention-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  appendRawAiInteraction({
    traceId,
    provider: "fake",
    model: "fake",
    direction: "request",
    payload: { hello: "world" },
  });

  assert.equal(fs.existsSync(oldDir), false, "old interaction dir should be pruned");

  const todayDir = path.join(aiInteractionDir, new Date().toISOString().slice(0, 10));
  assert.equal(fs.existsSync(todayDir), true, "today's interaction dir should remain");

  // Clean up the file this test wrote today.
  const probeFile = path.join(todayDir, `${traceId}.jsonl`);
  if (fs.existsSync(probeFile)) fs.rmSync(probeFile, { force: true });
});
