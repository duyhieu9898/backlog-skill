// Shared bootstrap for the dev/diagnostic dispatcher (scripts/dev.js).
//
// LOAD-BEARING RULE: this module (and every lib/* module) MUST NOT require any
// ../dist/* module at module top level. All dist requires happen INSIDE the
// exported functions. This preserves eval.js's invariant: AGENT_DB_FILE must be
// set before the first dist/config/paths require (sqliteFile resolves at
// module-eval time). dev.js routes the `eval` command to lib/eval.runEval(),
// which sets AGENT_DB_FILE itself before any dist require; the other commands
// (logs/smoke/eval-diff) reach dist through getContext() below and do not touch
// AGENT_DB_FILE. Each dev.js invocation runs exactly one command, so there is
// no cross-command cache contamination in a single process.

const path = require("node:path");

let cached = null;

/**
 * Resolve + cache the path/env bundle. Lazy-requires dist/config/paths and
 * loads agentDir/.env exactly once. Callers that need the eval DB (only
 * lib/eval.runEval) set AGENT_DB_FILE themselves and do NOT use this.
 */
function getContext() {
  if (cached) return cached;
  const paths = require("../../dist/config/paths");
  const { loadEnv } = require("../../dist/config/env");
  const agentDir = paths.agentDir;
  loadEnv(path.join(agentDir, ".env"));
  const evalDir = path.join(agentDir, "eval");
  cached = {
    agentDir,
    aiInteractionDir: paths.aiInteractionDir,
    aiInteractionIndex: paths.aiInteractionIndex,
    logDir: paths.logDir,
    dataDir: paths.dataDir,
    evalDir,
    reportsDir: path.join(evalDir, "reports"),
    baselinesDir: path.join(evalDir, "baselines"),
    evalDbFile: path.join(evalDir, "eval.sqlite"),
  };
  return cached;
}

/** Re-export the canonical .env loader so smoke scripts stop re-implementing it. */
function loadEnv(file) {
  return require("../../dist/config/env").loadEnv(file);
}

module.exports = { getContext, loadEnv };
