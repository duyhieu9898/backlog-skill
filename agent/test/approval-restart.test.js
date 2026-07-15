// Proves ADR 0017 P1.3: a persisted tool approval survives a DB close/reopen
// (simulated process restart) and lets the tool loop resume. Covers approve,
// reject, stale-digest invalidation, and replay/refusal — the last across two
// restarts.
//
// `paths.ts` resolves `sqliteFile` at module-eval time, so AGENT_DB_FILE must be
// set before any dist require. Each test file runs in its own subprocess, so an
// isolated temp DB here cannot disturb the shared agent/data/agent.sqlite.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Phase 2 — isolated temp DB, set env BEFORE dist requires.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-restart-"));
const dbFile = path.join(dbDir, "test.sqlite");
process.env.AGENT_DB_FILE = dbFile;

// Phase 3 — now paths.ts picks up the override.
const { sqliteFile } = require("../dist/config/paths");
const { closeDb, getDb } = require("../dist/storage/db");
const {
  createRun, getRun,
  getPendingApproval, listActiveApprovalGrants, listRunSteps,
} = require("../dist/storage/repositories");
const { buildCommandCatalog } = require("../dist/commands");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { AiRouter } = require("../dist/brain/router");
const { AgentToolLoop } = require("../dist/tools/loop");
const { ToolGateway } = require("../dist/tools/gateway");
const { ToolExecutor } = require("../dist/tools/executor");
const { FileTools } = require("../dist/tools/files");

// Phase 3b — the override must actually route the sqlite path.
assert.equal(sqliteFile, path.resolve(dbFile), "AGENT_DB_FILE must override sqliteFile");

// Phase 4 — release the handle and the temp files once the file's tests finish.
test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, "approval-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function message(text, suffix) {
  return {
    traceId: `approval-restart-trace-${suffix}`,
    provider: "telegram",
    chatId: `approval-restart-chat-${suffix}`,
    userId: "user",
    text,
    timestamp: new Date(),
  };
}

// Verbatim from tool-loop.test.js: routine test.prepare (no confirm) + sensitive
// test.create (writes marker, requires confirmation).
function executorFor(root, marker) {
  const schema = {
    type: "object",
    properties: {
      skipDates: {
        type: "array",
        items: { type: "string", format: "date" },
        maxItems: 10,
      },
    },
    required: ["skipDates"],
    additionalProperties: false,
  };
  const catalog = buildCommandCatalog({
    allow: [
      {
        name: "test.prepare",
        label: "Prepare test plan",
        cwd: root,
        argv: [
          process.execPath,
          "-e",
          "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s));",
        ],
        inputMode: "json-stdin",
        inputSchema: schema,
        requiresConfirmation: false,
        externalSideEffect: false,
      },
      {
        name: "test.create",
        label: "Create test effect",
        cwd: root,
        argv: [
          process.execPath,
          "-e",
          `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},s);process.stdout.write('created')});`,
        ],
        inputMode: "json-stdin",
        inputSchema: schema,
        requiresConfirmation: true,
        externalSideEffect: true,
      },
    ],
  });
  const policy = new PermissionPolicy({
    workspaceRoot: path.resolve(__dirname, "..", ".."),
    allowedReadRoots: [path.resolve(__dirname, "..", "..")],
    allowedWriteRoots: [path.resolve(__dirname, "..", "..")],
    deniedPaths: [],
  });
  return new ToolExecutor(new FileTools(policy), () => catalog);
}

// Fake provider: prepare -> create -> final text. Mirrors tool-loop.test.js.
function makeProvider() {
  return {
    async complete(input) {
      if (input.steps.length === 0) {
        return { toolCall: { name: "command.test.prepare", arguments: { skipDates: ["2026-07-01"] } } };
      }
      const plan = JSON.parse(input.steps[0].result.data.output);
      if (input.steps.length === 1) {
        return { toolCall: { name: "command.test.create", arguments: plan } };
      }
      return { text: "continued after confirmation" };
    },
  };
}

// Drives a fresh loop to the confirmation pause point and returns the workspace
// + shortId. loop.run() does not create the run row (production does that in
// AgentRuntime), so we create it explicitly — otherwise setRunStatus/finishRun
// are silent UPDATEs on a missing row.
async function driveToConfirmation(t) {
  const root = workspace(t);
  const marker = path.join(root, "effect.txt");
  const input = message("prepare then create", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  createRun({
    id: input.traceId,
    session_id: "default",
    principal_id: input.userId,
    channel: input.provider,
    user_request: input.text,
    trace_id: input.traceId,
  });
  const loop = new AgentToolLoop(
    new AiRouter({ provider: makeProvider(), providerName: "fake", model: "fake", systemPrompt: "test" }),
    new ToolGateway(executorFor(root, marker)),
  );
  const preview = await loop.run(input, "context");
  const shortId = preview.match(/Approval ID: ([a-f0-9]{8})/)[1];
  return { root, marker, input, shortId };
}

// Simulates a process restart: close the only connection (better-sqlite3
// checkpoints the WAL into the main file), then reopen the same file. The next
// loop instance reads the persisted rows because ApprovalService is stateless.
function restartDb() {
  closeDb();
  getDb();
}

// Rebuilds the entire loop graph — a brand-new executor, gateway, and loop — so
// nothing from the pre-restart instance leaks (mirrors independent processes).
function buildLoop(root, marker) {
  return new AgentToolLoop(
    new AiRouter({ provider: makeProvider(), providerName: "fake", model: "fake", systemPrompt: "test" }),
    new ToolGateway(executorFor(root, marker)),
  );
}

function confirmMessage(input, action, shortId) {
  return { ...input, text: `${action} ${shortId}`, traceId: `${input.traceId}-confirm` };
}

test("(a) approve resumes the tool loop across a DB close/reopen", async (t) => {
  const { root, marker, input, shortId } = await driveToConfirmation(t);

  assert.equal(getRun(input.traceId).status, "waiting_approval");
  assert.equal(getPendingApproval(shortId, input.userId, input.chatId).status, "pending");
  assert.equal(fs.existsSync(marker), false);

  restartDb();

  const reply = await buildLoop(root, marker).consumeScopedApproval(confirmMessage(input, "approve", shortId));

  assert.equal(reply, "continued after confirmation");
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { skipDates: ["2026-07-01"] });
  assert.equal(getPendingApproval(shortId, input.userId, input.chatId).status, "approved");
  assert.equal(getRun(input.traceId).status, "completed");

  const grants = listActiveApprovalGrants({ principalId: input.userId, runId: input.traceId });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].scope, "run");
  assert.equal(grants[0].run_id, input.traceId);

  const steps = listRunSteps(input.traceId);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.tool_name), ["command.test.prepare", "command.test.create"]);
});

test("(b) reject cancels the run across a DB close/reopen", async (t) => {
  const { root, marker, input, shortId } = await driveToConfirmation(t);

  restartDb();

  const reply = await buildLoop(root, marker).consumeScopedApproval(confirmMessage(input, "reject", shortId));

  assert.equal(reply, "Đã từ chối action đang chờ.");
  assert.equal(fs.existsSync(marker), false);
  assert.equal(getPendingApproval(shortId, input.userId, input.chatId).status, "rejected");
  assert.equal(getRun(input.traceId).status, "cancelled");
  assert.equal(listActiveApprovalGrants({ principalId: input.userId, runId: input.traceId }).length, 0);
});

test("(c) stale digest is invalidated across a DB close/reopen", async (t) => {
  const { root, marker, input, shortId } = await driveToConfirmation(t);

  // Tamper the stored digest; consumeScopedApproval recomputes the correct one
  // from payload.call, so the mismatch trips the digest gate in resolve().
  getDb().prepare("UPDATE pending_approvals SET action_digest = ? WHERE short_id = ?")
    .run("tampered-digest-value", shortId);

  restartDb();

  const reply = await buildLoop(root, marker).consumeScopedApproval(confirmMessage(input, "approve", shortId));

  assert.equal(reply, "Approval không tồn tại, đã hết hạn, hoặc action đã thay đổi.");
  assert.equal(fs.existsSync(marker), false);
  assert.equal(getPendingApproval(shortId, input.userId, input.chatId).status, "invalidated");
  assert.equal(getRun(input.traceId).status, "waiting_approval");
  assert.equal(listActiveApprovalGrants({ principalId: input.userId, runId: input.traceId }).length, 0);
});

test("(d) replay of an already-approved pending is refused across two restarts", async (t) => {
  const { root, marker, input, shortId } = await driveToConfirmation(t);

  // Restart #1 — the approval resolves and the loop resumes.
  restartDb();
  const first = await buildLoop(root, marker).consumeScopedApproval(confirmMessage(input, "approve", shortId));
  assert.equal(first, "continued after confirmation");
  assert.equal(fs.existsSync(marker), true);
  assert.equal(getRun(input.traceId).status, "completed");
  assert.equal(listActiveApprovalGrants({ principalId: input.userId, runId: input.traceId }).length, 1);

  // Restart #2 — replaying the same shortId must be refused: no widening, no
  // re-execution. The row exists but its status is no longer "pending".
  restartDb();
  const replay = await buildLoop(root, marker).consumeScopedApproval(confirmMessage(input, "approve", shortId));

  assert.equal(replay, "Approval không tồn tại, đã hết hạn, hoặc action đã thay đổi.");
  assert.equal(listActiveApprovalGrants({ principalId: input.userId, runId: input.traceId }).length, 1);
  assert.equal(listRunSteps(input.traceId).length, 2);
});
