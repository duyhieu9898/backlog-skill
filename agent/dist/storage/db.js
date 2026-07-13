"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.initializeSchema = initializeSchema;
exports.closeDb = closeDb;
const node_fs_1 = __importDefault(require("node:fs"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const paths_1 = require("../config/paths");
let db = null;
function getDb() {
    if (!db) {
        node_fs_1.default.mkdirSync(paths_1.dataDir, { recursive: true });
        db = new better_sqlite3_1.default(paths_1.sqliteFile);
        db.pragma("journal_mode = WAL");
        initializeSchema(db);
    }
    return db;
}
function initializeSchema(database = getDb()) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS kv_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_created
      ON chat_messages(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      owner_chat_id TEXT NOT NULL,
      source_trace_id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      local_path TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      delivered_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_expiry ON artifacts(expires_at);

    CREATE TABLE IF NOT EXISTS trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trace_events_trace_created
      ON trace_events(trace_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS command_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      exit_code INTEGER,
      output_tail TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_command_runs_started
      ON command_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      chat_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      command_name TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      daily_at TEXT,
      cron_expr TEXT,
      enabled INTEGER NOT NULL,
      delivery TEXT NOT NULL,
      notify_on_change_only INTEGER NOT NULL,
      prepare_effect_json TEXT,
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_trace_id TEXT,
      last_output_digest TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      lease_owner TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      output_tail TEXT NOT NULL,
      output_digest TEXT NOT NULL,
      notification_sent INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_job_finished
      ON scheduled_runs(job_name, finished_at DESC);
  `);
    migrateScheduledJobs();
    migrateChatMessages();
}
function migrateScheduledJobs() {
    const columns = new Set(db
        .prepare(`PRAGMA table_info(scheduled_jobs)`)
        .all()
        .map((row) => row.name));
    if (!columns.has("version")) {
        db.prepare(`ALTER TABLE scheduled_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 1`).run();
    }
    if (!columns.has("lease_owner")) {
        db.prepare(`ALTER TABLE scheduled_jobs ADD COLUMN lease_owner TEXT`).run();
    }
    if (!columns.has("lease_until")) {
        db.prepare(`ALTER TABLE scheduled_jobs ADD COLUMN lease_until TEXT`).run();
    }
    if (!columns.has("daily_at")) {
        db.prepare(`ALTER TABLE scheduled_jobs ADD COLUMN daily_at TEXT`).run();
    }
    if (!columns.has("cron_expr")) {
        db.prepare(`ALTER TABLE scheduled_jobs ADD COLUMN cron_expr TEXT`).run();
    }
}
function migrateChatMessages() {
    const columns = new Set(db
        .prepare(`PRAGMA table_info(chat_messages)`)
        .all()
        .map((row) => row.name));
    if (!columns.has("session_id")) {
        db.prepare(`ALTER TABLE chat_messages ADD COLUMN session_id TEXT`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`).run();
    }
}
function closeDb() {
    db?.close();
    db = null;
}
