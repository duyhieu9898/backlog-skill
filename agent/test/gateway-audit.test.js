// Proves ADR 0017 P2.1: the gateway emits an audit record for each allow,
// approval-requested, deny, and execution result, and every record carries the
// four correlation ids (traceId, sessionId, runId, toolCallId).
//
// Audit records reuse the existing structured logger and land in the trace_events
// table (see logging/logger.ts -> insertTraceEvent). We assert by querying
// listTraceEvents(traceId) and filtering the `gateway.*` namespace. We never read
// the ai-interactions JSONL log (it is not isolated by AGENT_DB_FILE and carries
// the NUL-pollution gotcha documented in test-ai-log-nul-pollution).
//
// AGENT_DB_FILE must be set before any dist require: paths.ts resolves sqliteFile
// at module-eval time. Each test file runs in its own subprocess, so the temp DB
// here cannot disturb the shared agent/data/agent.sqlite.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Isolated temp DB, set BEFORE dist requires.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-audit-"));
const dbFile = path.join(dbDir, "test.sqlite");
process.env.AGENT_DB_FILE = dbFile;

const { sqliteFile } = require("../dist/config/paths");
const { closeDb } = require("../dist/storage/db");
const { createRun, listTraceEvents } = require("../dist/storage/repositories");
const { buildCommandCatalog } = require("../dist/commands");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { AiRouter } = require("../dist/brain/router");
const { AgentToolLoop } = require("../dist/tools/loop");
const { ToolGateway } = require("../dist/tools/gateway");
const { ToolExecutor } = require("../dist/tools/executor");
const { FileTools } = require("../dist/tools/files");
const { toolRegistry, registerTool } = require("../dist/tools/registry");

assert.equal(sqliteFile, path.resolve(dbFile), "AGENT_DB_FILE must override sqliteFile");

test.after(() => {
  toolRegistry.clear();
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

// A destructive custom tool so the deny scenario has a clean, self-contained
// deny at the gateway (risk: "destructive" -> authorize() sets `blocked`).
function ensureNukeTool() {
  if (!toolRegistry.get("test.custom.nuke")) {
    registerTool({
      definition: {
        name: "test.custom.nuke",
        description: "Destructive operation.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      risk: "destructive",
      prepare: (call) => ({ call, key: "test.custom.nuke", digest: "nuke-digest", preview: "destructive op" }),
      execute: async () => ({ ok: true, code: "SHOULD_NOT_RUN", summary: "unreachable" }),
    });
  }
}
ensureNukeTool();

function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, "gateway-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function message(text, suffix) {
  return {
    traceId: `gateway-audit-trace-${suffix}`,
    provider: "telegram",
    chatId: `gateway-audit-chat-${suffix}`,
    userId: "user",
    text,
    timestamp: new Date(),
  };
}

// Verbatim pattern from approval-restart.test.js: routine test.prepare (no
// confirm) + sensitive test.create (writes marker, requires confirmation).
function executorFor(root, marker) {
  const schema = {
    type: "object",
    properties: {
      skipDates: { type: "array", items: { type: "string", format: "date" }, maxItems: 10 },
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

function buildLoop(root, marker, provider) {
  return new AgentToolLoop(
    new AiRouter({ provider, providerName: "fake", model: "fake", systemPrompt: "test" }),
    new ToolGateway(executorFor(root, marker)),
  );
}

// routine command -> final text.
function allowProvider() {
  return {
    async complete(input) {
      if (input.steps.length === 0) {
        return { toolCall: { name: "command.test.prepare", arguments: { skipDates: ["2026-07-01"] } } };
      }
      return { text: "done" };
    },
  };
}

// destructive custom tool -> final text.
function denyProvider() {
  return {
    async complete(input) {
      if (input.steps.length === 0) return { toolCall: { name: "test.custom.nuke", arguments: {} } };
      return { text: "denied" };
    },
  };
}

// prepare -> create (confirm) -> final text.
function confirmProvider() {
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

// Gateway audit records for a trace, parsed into plain objects.
function gatewayEvents(traceId) {
  return listTraceEvents(traceId, 100)
    .filter((e) => e.event.startsWith("gateway."))
    .map((e) => ({ event: e.event, ...JSON.parse(e.payload_json) }));
}

function suffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function confirmMessage(input, action, shortId) {
  return { ...input, text: `${action} ${shortId}`, traceId: `${input.traceId}-confirm` };
}

test("allow decision and execution result are audited with all four ids", async (t) => {
  const root = workspace(t);
  const input = message("prepare", suffix());
  createRun({
    id: input.traceId, session_id: "default", principal_id: input.userId,
    channel: input.provider, user_request: input.text, trace_id: input.traceId,
  });

  await buildLoop(root, path.join(root, "effect.txt"), allowProvider()).run(input, "context");

  const events = gatewayEvents(input.traceId);
  const decisions = events.filter((e) => e.event === "gateway.decision");
  const executed = events.filter((e) => e.event === "gateway.executed");

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "allow");
  assert.equal(decisions[0].stage, "authorize");
  assert.equal(decisions[0].toolName, "command.test.prepare");

  assert.equal(executed.length, 1);
  assert.equal(executed[0].ok, true);

  // Both records carry the same four correlation ids.
  for (const record of [decisions[0], executed[0]]) {
    assert.equal(record.traceId, input.traceId);
    assert.equal(record.runId, input.traceId, "runId defaults to traceId in the loop");
    assert.equal(record.sessionId, "default");
    assert.ok(record.toolCallId.startsWith("tc_"), `toolCallId looks generated: ${record.toolCallId}`);
  }
  assert.equal(decisions[0].toolCallId, executed[0].toolCallId, "decision and result share a toolCallId");
});

test("deny decision is audited and produces no execution record", async (t) => {
  const root = workspace(t);
  const input = message("nuke", suffix());
  createRun({
    id: input.traceId, session_id: "default", principal_id: input.userId,
    channel: input.provider, user_request: input.text, trace_id: input.traceId,
  });

  await buildLoop(root, path.join(root, "effect.txt"), denyProvider()).run(input, "context");

  const events = gatewayEvents(input.traceId);
  const decisions = events.filter((e) => e.event === "gateway.decision");
  const executed = events.filter((e) => e.event === "gateway.executed");

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "deny");
  assert.equal(decisions[0].stage, "authorize");
  assert.equal(decisions[0].reasonCode, "CUSTOM_TOOL_BLOCKED");
  assert.equal(decisions[0].toolName, "test.custom.nuke");
  assert.equal(executed.length, 0, "a denied call is not executed");

  assert.equal(decisions[0].traceId, input.traceId);
  assert.equal(decisions[0].runId, input.traceId);
  assert.equal(decisions[0].sessionId, "default");
  assert.ok(decisions[0].toolCallId.startsWith("tc_"));
});

test("approval-requested decision is audited before the loop pauses", async (t) => {
  const root = workspace(t);
  const marker = path.join(root, "effect.txt");
  const input = message("prepare then create", suffix());
  createRun({
    id: input.traceId, session_id: "default", principal_id: input.userId,
    channel: input.provider, user_request: input.text, trace_id: input.traceId,
  });

  const preview = await buildLoop(root, marker, confirmProvider()).run(input, "context");
  assert.match(preview, /Approval ID/, "loop paused for approval");

  const events = gatewayEvents(input.traceId);
  const decisions = events.filter((e) => e.event === "gateway.decision");
  const executed = events.filter((e) => e.event === "gateway.executed");

  // prepare (allow) then create (confirm).
  const allow = decisions.filter((d) => d.outcome === "allow");
  const confirm = decisions.filter((d) => d.outcome === "confirm");
  assert.equal(allow.length, 1);
  assert.equal(confirm.length, 1);
  assert.equal(confirm[0].toolName, "command.test.create");
  assert.equal(executed.length, 1, "only the allowed prepare step executed before the pause");
  assert.equal(fs.existsSync(marker), false);
});

test("approval resume re-audits allow + executed with the same toolCallId", async (t) => {
  const root = workspace(t);
  const marker = path.join(root, "effect.txt");
  const input = message("prepare then create", suffix());
  createRun({
    id: input.traceId, session_id: "default", principal_id: input.userId,
    channel: input.provider, user_request: input.text, trace_id: input.traceId,
  });

  // Drive to the confirmation pause; capture the toolCallId of the confirm decision.
  const loop = buildLoop(root, marker, confirmProvider());
  const preview = await loop.run(input, "context");
  const shortId = preview.match(/Approval ID: ([a-f0-9]{8})/)[1];
  const confirmToolCallId = gatewayEvents(input.traceId)
    .filter((e) => e.event === "gateway.decision" && e.outcome === "confirm")[0].toolCallId;

  // Approve on a fresh loop instance (the persisted payload carries toolCallId).
  const reply = await buildLoop(root, marker, confirmProvider())
    .consumeScopedApproval(confirmMessage(input, "approve", shortId));
  assert.equal(reply, "continued after confirmation");

  // The resume runs under a new message traceId (the approve callback), so gather
  // gateway events from both traceIds. runId ties them to the same run.
  const resumed = gatewayEvents(`${input.traceId}-confirm`);
  const resumedAllow = resumed.filter((e) => e.event === "gateway.decision" && e.outcome === "allow");
  const resumedExecuted = resumed.filter((e) => e.event === "gateway.executed");

  assert.ok(resumedAllow.length >= 1, "the resumed authorize emits an allow decision");
  assert.equal(resumedExecuted.length, 1);
  assert.equal(resumedExecuted[0].ok, true);

  // confirm (pause) -> allow (resume) -> executed all share the same toolCallId.
  assert.equal(resumedAllow[0].toolCallId, confirmToolCallId);
  assert.equal(resumedExecuted[0].toolCallId, confirmToolCallId);
  // runId stays the original run across the resume boundary.
  assert.equal(resumedExecuted[0].runId, input.traceId);
});
