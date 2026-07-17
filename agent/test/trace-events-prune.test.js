// trace_events auto-prune (ADR 0017 follow-on). raw-AI JSONL already pruned by
// retention; trace_events did not, so the table could grow unbounded in a
// long-running process. insertTraceEvent now prunes on a 60s throttle using
// logging.traceRetentionDays (default 30); this test exercises pruneTraceEvents
// directly.
//
// AGENT_DB_FILE must be set before any dist require.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-prune-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { getDb, closeDb } = require("../dist/storage/db");
const { insertTraceEvent, listTraceEvents, pruneTraceEvents } = require("../dist/storage/repositories");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function insertWithAge(traceId, event, ageDays) {
  const created = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  getDb()
    .prepare(`INSERT INTO trace_events (trace_id, event, payload_json, created_at) VALUES (?, ?, ?, ?)`)
    .run(traceId, event, "{}", created);
}

test("pruneTraceEvents deletes rows older than retention and keeps recent ones", () => {
  insertTraceEvent("tr_recent", "test.event", { x: 1 }); // now
  insertWithAge("tr_old", "test.event", 40); // 40 days ago
  assert.equal(listTraceEvents("tr_recent", 10).length, 1);
  assert.equal(listTraceEvents("tr_old", 10).length, 1);

  const deleted = pruneTraceEvents(30);
  assert.ok(deleted >= 1, "at least the old row is deleted");

  assert.equal(listTraceEvents("tr_recent", 10).length, 1, "recent row is kept");
  assert.equal(listTraceEvents("tr_old", 10).length, 0, "old row is pruned");
});

test("pruneTraceEvents is a no-op for invalid retention", () => {
  insertTraceEvent("tr_safe", "test.event", {});
  assert.equal(pruneTraceEvents(0), 0);
  assert.equal(pruneTraceEvents(NaN), 0);
  assert.equal(listTraceEvents("tr_safe", 10).length, 1);
});
