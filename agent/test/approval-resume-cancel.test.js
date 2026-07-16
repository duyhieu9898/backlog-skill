// Proves ADR 0017 P2.3 (fix A): after an owner approves a paused tool action,
// the resumed tool loop still honors cancellation. Before the fix,
// `consumeScopedApproval` dropped the AbortSignal when it called `this.run(...)`,
// so a resumed long-running step could not be cancelled by `/stop` or a run
// deadline. The signal is now forwarded, so the resumed loop aborts mid-step and
// the run is terminally recorded as `cancelled`.
//
// `paths.ts` resolves `sqliteFile` at module-eval time, so AGENT_DB_FILE must be
// set before any dist require. Each test file runs in its own subprocess.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Isolated temp DB, set BEFORE dist requires.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-resume-cancel-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { closeDb } = require("../dist/storage/db");
const { createRun, getRun } = require("../dist/storage/repositories");
const { buildCommandCatalog } = require("../dist/commands");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { AiRouter } = require("../dist/brain/router");
const { AgentToolLoop } = require("../dist/tools/loop");
const { ToolGateway } = require("../dist/tools/gateway");
const { ToolExecutor } = require("../dist/tools/executor");
const { FileTools } = require("../dist/tools/files");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, "approval-resume-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const schema = {
  type: "object",
  properties: {
    skipDates: { type: "array", items: { type: "string", format: "date" }, maxItems: 10 },
  },
  required: ["skipDates"],
  additionalProperties: false,
};

function executorFor(root, createMarker, longStartMarker) {
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
          `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(createMarker)},s);process.stdout.write('created')});`,
        ],
        inputMode: "json-stdin",
        inputSchema: schema,
        requiresConfirmation: true,
        externalSideEffect: true,
      },
      {
        name: "test.long",
        label: "Long test step",
        cwd: root,
        argv: [
          process.execPath,
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(longStartMarker)},'started');setInterval(()=>{},1000);`,
        ],
        requiresConfirmation: false,
        externalSideEffect: false,
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

// prepare -> create (pauses for approval) -> long (runs forever, cancel target).
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
      // After resume: a step that would run forever without cancellation.
      return { toolCall: { name: "command.test.long", arguments: {} } };
    },
  };
}

function buildLoop(root, createMarker, longStartMarker) {
  return new AgentToolLoop(
    new AiRouter({ provider: makeProvider(), providerName: "fake", model: "fake", systemPrompt: "test" }),
    new ToolGateway(executorFor(root, createMarker, longStartMarker)),
  );
}

function message(text, suffix) {
  return {
    traceId: `approval-resume-cancel-trace-${suffix}`,
    provider: "telegram",
    chatId: `approval-resume-cancel-chat-${suffix}`,
    userId: "user",
    text,
    timestamp: new Date(),
  };
}

function confirmMessage(input, action, shortId) {
  return { ...input, text: `${action} ${shortId}`, traceId: `${input.traceId}-confirm` };
}

async function driveToConfirmation(t) {
  const root = workspace(t);
  const createMarker = path.join(root, "effect.txt");
  const longStartMarker = path.join(root, "long-started.txt");
  const input = message("prepare then create", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  createRun({
    id: input.traceId,
    session_id: "default",
    principal_id: input.userId,
    channel: input.provider,
    user_request: input.text,
    trace_id: input.traceId,
  });
  const loop = buildLoop(root, createMarker, longStartMarker);
  const preview = await loop.run(input, "context");
  const shortId = preview.match(/Approval ID: ([a-f0-9]{8})/)[1];
  return { root, createMarker, longStartMarker, input, shortId, loop };
}

test("a resumed tool loop honors an AbortSignal forwarded through consumeScopedApproval", async (t) => {
  const { createMarker, longStartMarker, input, shortId, loop } = await driveToConfirmation(t);

  assert.equal(getRun(input.traceId).status, "waiting_approval");
  const confirm = confirmMessage(input, "approve", shortId);

  const controller = new AbortController();
  // Resume WITHOUT awaiting: the resumed loop should reach the long step.
  const resumed = loop.consumeScopedApproval(confirm, undefined, undefined, controller.signal);

  // Wait until the resumed long command is actually running (its start marker
  // exists). Polling the marker avoids a race with the quick approved step.
  for (let i = 0; i < 400 && !fs.existsSync(longStartMarker); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(longStartMarker), true, "resumed long command should be running");

  controller.abort(new Error("Cancelled by owner."));
  const reply = await resumed;

  assert.equal(reply, "Run cancelled.");
  assert.equal(getRun(input.traceId).status, "cancelled");
  // The approved action completed before cancellation reached the resumed loop.
  assert.equal(fs.existsSync(createMarker), true);
});
