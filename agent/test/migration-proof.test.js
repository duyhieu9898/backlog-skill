// ADR 0017 P2.7 — SQLite migration proof.
//
// Proves `initializeSchema` (agent/src/storage/db.ts) brings a pre-existing
// *old-schema* database current without losing rows:
//   - `scheduled_jobs` missing the 7 additive columns → migrator ADD COLUMNs them
//     with declared defaults (version=1, source='config', timezone='UTC', …).
//   - `chat_messages` missing `session_id` → migrator ADD COLUMNs it.
//   - the legacy `pending_confirmations` table (P0 cutover) → DROP IF EXISTS removes it.
//   - the current `pending_approvals` table is created afresh.
//   - re-running on an already-current DB is idempotent (no error, no dup columns).
//
// `paths.ts` resolves `sqliteFile` at module-eval time, so AGENT_DB_FILE must be set
// before any dist require. Each test file runs in its own node --test subprocess.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-proof-"));
const dbFile = path.join(dbDir, "test.sqlite");
process.env.AGENT_DB_FILE = dbFile;

const { closeDb, getDb } = require("../dist/storage/db");
const { getScheduledJob } = require("../dist/storage/repositories");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function columnsOf(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
}

// Seed an old-schema DB directly (NOT through getDb, so initializeSchema has not
// run yet). Mirrors a file written by a pre-cutover agent version.
function seedOldSchema(file) {
  const direct = new Database(file);
  direct.exec(`
    CREATE TABLE scheduled_jobs (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      command_name TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      delivery TEXT NOT NULL,
      notify_on_change_only INTEGER NOT NULL,
      prepare_effect_json TEXT,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_trace_id TEXT,
      last_output_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Legacy one-row-per-chat confirmation protocol, removed in the P0 cutover.
    CREATE TABLE pending_confirmations (
      chat_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL
    );
  `);
  direct.prepare(
    `INSERT INTO scheduled_jobs
      (name, label, command_name, interval_minutes, enabled, delivery, notify_on_change_only, created_at, updated_at)
     VALUES (?, 'Legacy job', 'bemo.late-list', 15, 1, 'telegram', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run("legacy-job");
  direct.prepare(
    `INSERT INTO chat_messages (chat_id, user_id, role, content, trace_id, created_at)
     VALUES ('legacy-chat', 'owner', 'user', 'hello', 'tr_legacy', '2026-01-01T00:00:00Z')`,
  ).run();
  direct.prepare(`INSERT INTO pending_confirmations (chat_id, digest) VALUES ('legacy-chat', 'deadbeef')`).run();
  direct.close();
}

test("initializeSchema migrates a pre-existing old-schema DB and preserves rows", () => {
  seedOldSchema(dbFile);

  // First open through getDb(): runs initializeSchema + both ADD COLUMN migrators.
  const db = getDb();

  // scheduled_jobs: 7 additive columns present with declared defaults.
  const sjCols = columnsOf(db, "scheduled_jobs");
  for (const col of ["version", "lease_owner", "lease_until", "daily_at", "cron_expr", "source", "timezone"]) {
    assert.ok(sjCols.has(col), `scheduled_jobs.${col} should be added by migrator`);
  }
  const legacyJob = getScheduledJob("legacy-job");
  assert.ok(legacyJob, "seeded scheduled_jobs row survives migration");
  assert.equal(legacyJob.label, "Legacy job");
  assert.equal(legacyJob.command_name, "bemo.late-list");
  assert.equal(legacyJob.version, 1, "version defaults to 1");
  assert.equal(legacyJob.source, "config", "source defaults to 'config'");
  assert.equal(legacyJob.timezone, "UTC", "timezone defaults to 'UTC'");
  assert.equal(legacyJob.lease_owner, null);
  assert.equal(legacyJob.cron_expr, null);

  // chat_messages: session_id added, seeded row intact.
  const cmCols = columnsOf(db, "chat_messages");
  assert.ok(cmCols.has("session_id"), "chat_messages.session_id should be added by migrator");
  const legacyMsg = db.prepare("SELECT chat_id, content FROM chat_messages WHERE trace_id = ?").get("tr_legacy");
  assert.deepEqual(legacyMsg, { chat_id: "legacy-chat", content: "hello" });

  // Legacy pending_confirmations dropped; current pending_approvals created.
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name));
  assert.ok(!tables.has("pending_confirmations"), "legacy pending_confirmations table is dropped");
  assert.ok(tables.has("pending_approvals"), "current pending_approvals table is created");
  const paCols = columnsOf(db, "pending_approvals");
  assert.ok(paCols.has("short_id") && paCols.has("action_digest"), "pending_approvals has the current columns");
});

test("re-opening an already-current DB is idempotent (no error, no duplicate columns)", () => {
  closeDb();
  const db = getDb();
  const sjCols = columnsOf(db, "scheduled_jobs");
  // Each migrator column appears exactly once.
  assert.equal([...sjCols].filter((c) => c === "version").length, 1);
  assert.equal([...sjCols].filter((c) => c === "source").length, 1);
  const cmCols = columnsOf(db, "chat_messages");
  assert.equal([...cmCols].filter((c) => c === "session_id").length, 1);
  // The seeded row is still there after the second open.
  assert.ok(getScheduledJob("legacy-job"));
});
