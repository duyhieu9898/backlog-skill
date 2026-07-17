// ADR 0017 P2.7 — scheduled `prepareEffect` smoke.
//
// scheduler.test.js:195/:219 cover a configured schedule's PRIMARY command, but
// `runConfiguredEffect` (scheduler.ts:424-452) — the prepare(stdout JSON) -> effect
// handoff — had no coverage. This proves a configured `prepareEffect` runs both
// steps through the gateway: the prepare command emits JSON, the effect command
// receives that JSON on stdin and executes.
//
// AGENT_COMMANDS_FILE / AGENT_DB_FILE must be set before any dist require.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-effect-"));
const marker = path.join(workspaceDir, "effect.txt");
const commandsFile = path.join(workspaceDir, "commands.json");
const dbFile = path.join(workspaceDir, "test.sqlite");

const permissiveSchema = { type: "object", properties: {}, additionalProperties: true };
fs.writeFileSync(
  commandsFile,
  JSON.stringify({
    allow: [
      {
        name: "test.read",
        label: "Primary scheduled read",
        cwd: workspaceDir,
        argv: [process.execPath, "-e", 'process.stdout.write("primary-ok")'],
        requiresConfirmation: false,
        externalSideEffect: false,
      },
      {
        name: "prep.step",
        label: "Prepare effect JSON",
        cwd: workspaceDir,
        argv: [
          process.execPath,
          "-e",
          "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({marker:'pe-ok'})))",
        ],
        inputMode: "json-stdin",
        inputSchema: permissiveSchema,
        requiresConfirmation: false,
        externalSideEffect: false,
      },
      {
        name: "eff.step",
        label: "Run effect from prepared JSON",
        cwd: workspaceDir,
        argv: [
          process.execPath,
          "-e",
          `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(marker)},s))`,
        ],
        inputMode: "json-stdin",
        inputSchema: permissiveSchema,
        requiresConfirmation: false,
        externalSideEffect: true,
      },
    ],
  }),
);
process.env.AGENT_COMMANDS_FILE = commandsFile;
process.env.AGENT_DB_FILE = dbFile;

const { loadCommandCatalog } = require("../dist/commands");
const { normalizeScheduledCheck, runScheduledCheck } = require("../dist/scheduler");
const { closeDb } = require("../dist/storage/db");

test.after(() => {
  closeDb();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test("a configured prepareEffect runs prepare(JSON) then effect(stdin) through the gateway", async () => {
  const catalog = loadCommandCatalog();
  const check = normalizeScheduledCheck(
    {
      name: "prep-effect-smoke",
      command: "test.read",
      cron: "*/5 * * * *",
      enabled: true,
      prepareEffect: { prepareCommand: "prep.step", effectCommand: "eff.step", prepareInput: {} },
    },
    catalog,
  );

  const result = await runScheduledCheck({
    check,
    principalId: "prep-effect-owner",
    chatId: "prep-effect-chat",
    defaultTimeoutMs: 5000,
  });

  assert.equal(result.status, "success", `scheduled run failed: ${result.outputTail}`);
  // The effect command received the prepare step's JSON on stdin and wrote it out.
  assert.ok(fs.existsSync(marker), "effect marker file was written");
  // runCommand pipes `JSON.stringify(input) + "\n"` to stdin; trim the trailing newline.
  assert.equal(fs.readFileSync(marker, "utf8").trim(), JSON.stringify({ marker: "pe-ok" }));
  // Primary command output is preserved alongside the effect summary. The effect's
  // "pe-ok" payload went to its stdin (the marker file above), not to stdout.
  assert.match(result.outputTail, /primary-ok/);
  assert.match(result.outputTail, /Scheduled effect/);
});
