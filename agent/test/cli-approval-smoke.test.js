// ADR 0017 P2.7 — CLI approval smoke (both halves through the real binary).
//
// cli.test.js:65 only proves the resume half (it seeds a pending in-process, then
// runs `approve <id>` via the CLI). This proves the FULL lifecycle through dist/cli.js:
//   1st invocation ("cli.smoke") -> pauses and prints the Approval ID.
//   2nd invocation ("approve <id>") -> resumes, the action runs, output appears.
//
// AGENT_COMMANDS_FILE / AGENT_DB_FILE are passed to the subprocess via env so the CLI
// resolves a harmless test command and writes to an isolated DB.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-smoke-"));
const commandsFile = path.join(workspaceDir, "commands.json");
const dbFile = path.join(workspaceDir, "test.sqlite");
fs.writeFileSync(
  commandsFile,
  JSON.stringify({
    allow: [
      {
        name: "cli.smoke",
        label: "CLI smoke command",
        cwd: workspaceDir,
        argv: [process.execPath, "-e", 'process.stdout.write("cli-smoke-ok")'],
        requiresConfirmation: true,
      },
    ],
  }),
);
process.env.AGENT_COMMANDS_FILE = commandsFile;
process.env.AGENT_DB_FILE = dbFile;

const { LOCAL_CLI_CHAT_ID, LOCAL_CLI_USER_ID } = require("../dist/adapters/cli");
const { getPendingApproval } = require("../dist/storage/repositories");
const { closeDb, getDb } = require("../dist/storage/db");

const agentDir = path.join(__dirname, "..");
const cliPath = path.join(agentDir, "dist", "cli.js");
const childEnv = { ...process.env, AGENT_COMMANDS_FILE: commandsFile, AGENT_DB_FILE: dbFile };

test.after(() => {
  closeDb();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function runCli(arg) {
  return execFileSync(process.execPath, [cliPath, arg], {
    cwd: agentDir,
    encoding: "utf8",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("CLI pauses on a confirmation command, then resumes on approve — both via the real binary", () => {
  // 1st half: the command requires confirmation, so it pauses and prints the id.
  const firstOutput = runCli("cli.smoke");
  const shortId = (firstOutput.match(/Approval ID: ([a-f0-9]{8})/) || [])[1];
  assert.ok(shortId, "first CLI invocation prints an Approval ID");
  assert.match(firstOutput, /cần xác nhận/);

  // 2nd half: approving runs the action through the gateway.
  const secondOutput = runCli(`approve ${shortId}`);
  assert.match(secondOutput, /cli-smoke-ok/);

  // The child wrote the approval into the shared isolated DB; re-open in the parent
  // to read the final state deterministically.
  closeDb();
  getDb();
  assert.equal(
    getPendingApproval(shortId, LOCAL_CLI_USER_ID, LOCAL_CLI_CHAT_ID).status,
    "approved",
  );
});
