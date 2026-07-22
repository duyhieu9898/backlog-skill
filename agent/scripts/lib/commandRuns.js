// command_runs drill-down for `dev.js cmds` — the one telemetry surface dev.js
// didn't used to expose (terminal command history: exit code, output tail, error).
// This Node module replaces the old skills/debug-eval-loop-skill/scripts/query.py
// so the improvement loop has a single engine + the skill is doc-only.
//
// DB resolution: getDb() honors AGENT_DB_FILE (default production agent/data/agent.sqlite;
// set AGENT_DB_FILE=eval/eval.sqlite to inspect an eval run). No dist require at module
// top level — all dist requires are inside the functions (see bootstrap.js).

function db() {
  const { getDb } = require("../../dist/storage/db");
  return getDb();
}

/** `cmds list`: N most recent command_runs, newest first. */
function listCommandRuns(limit = 10) {
  return db().prepare(
    "SELECT trace_id, command_name, status, started_at, finished_at, exit_code, error_message "
    + "FROM command_runs ORDER BY started_at DESC LIMIT ?",
  ).all(limit);
}

/** `cmds show <traceId>`: full command_runs rows for one trace (incl. cwd, command, output_tail). */
function getCommandRuns(traceId) {
  return db().prepare(
    "SELECT command_name, cwd, command, status, started_at, finished_at, exit_code, output_tail, error_message "
    + "FROM command_runs WHERE trace_id = ?",
  ).all(traceId);
}

module.exports = { listCommandRuns, getCommandRuns };
