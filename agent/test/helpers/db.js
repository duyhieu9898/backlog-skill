// Isolates a test file's SQLite database so it never touches the shared
// agent/data/agent.sqlite. Require this as the FIRST statement after the
// node: builtins in a test file, BEFORE any ../dist require, so that
// dist/config/paths picks up AGENT_DB_FILE at module-eval time. Each test file
// runs in its own subprocess, so the temp DB cannot disturb other files.
//
//   const test = require("node:test");
//   const closeIsolatedDb = require("./helpers/db");   // sets AGENT_DB_FILE
//   const { ... } = require("../dist/...");             // now isolated
//   test.after(() => closeIsolatedDb());
//
// Returns a cleanup function that closes the DB handle and removes the temp dir.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
process.env.AGENT_DB_FILE = path.join(dir, "test.sqlite");

module.exports = function closeIsolatedDb() {
  try {
    require("../../dist/storage/db").closeDb();
  } catch {
    // DB may not have been opened by this file — nothing to close.
  }
  fs.rmSync(dir, { recursive: true, force: true });
};
