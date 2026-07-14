const assert = require("node:assert/strict");
const test = require("node:test");

const { ToolGateway } = require("../dist/tools/gateway");
const { toolRegistry, registerTool } = require("../dist/tools/registry");

// Register three distinct custom tools (unique test.* names) once, guarded so
// the file is safe to re-run. Risk level is the only policy input for a custom
// tool: routine runs freely, sensitive needs a scoped approval, destructive is
// always denied at the gateway.
function ensureTestTools() {
  if (!toolRegistry.get("test.custom.echo")) {
    registerTool({
      definition: {
        name: "test.custom.echo",
        description: "Echo arguments back.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      risk: "routine",
      prepare: (call) => ({ call, key: "test.custom.echo", digest: "echo-digest", preview: `echo: ${call.arguments.message}` }),
      execute: async (prepared) => ({ ok: true, code: "CUSTOM_ECHO", summary: "Echoed.", data: { message: prepared.call.arguments.message } }),
    });
  }
  if (!toolRegistry.get("test.custom.action")) {
    registerTool({
      definition: {
        name: "test.custom.action",
        description: "Performs a sensitive action.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      risk: "sensitive",
      prepare: (call) => ({ call, key: "test.custom.action", digest: "action-digest", preview: "sensitive action" }),
      execute: async () => ({ ok: true, code: "CUSTOM_ACTION_OK", summary: "Done." }),
    });
  }
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

ensureTestTools();

test("routine custom tool runs without confirmation through the gateway", async () => {
  const gateway = new ToolGateway();
  const prepared = gateway.prepare({ name: "test.custom.echo", arguments: { message: "hello" } }, "trace-routine");
  assert.equal(prepared.requiresConfirmation, false);
  assert.equal(prepared.blocked, undefined);
  assert.equal(prepared.customTool.risk, "routine");

  const result = await gateway.execute(prepared, { traceId: "trace-routine", chatId: "chat-1" });
  assert.equal(result.ok, true);
  assert.equal(result.code, "CUSTOM_ECHO");
  assert.equal(result.data.message, "hello");
});

test("sensitive custom tool requires confirmation and runs after approval", async () => {
  const gateway = new ToolGateway();

  const pending = gateway.prepare({ name: "test.custom.action", arguments: {} }, "trace-sensitive");
  assert.equal(pending.requiresConfirmation, true);
  assert.equal(pending.blocked, undefined);

  // Same call re-prepared once the run holds a covering approval grant.
  const approved = gateway.prepare({ name: "test.custom.action", arguments: {} }, "trace-sensitive", undefined, "chat-1", undefined, true);
  assert.equal(approved.requiresConfirmation, false);

  const result = await gateway.execute(approved, { traceId: "trace-sensitive", chatId: "chat-1" });
  assert.equal(result.ok, true);
  assert.equal(result.code, "CUSTOM_ACTION_OK");
});

test("destructive custom tool is blocked at the gateway and never executes", async () => {
  const gateway = new ToolGateway();
  const prepared = gateway.prepare({ name: "test.custom.nuke", arguments: {} }, "trace-destructive");
  assert.equal(prepared.blocked?.code, "CUSTOM_TOOL_BLOCKED");
  assert.equal(prepared.requiresConfirmation, false);

  const result = await gateway.execute(prepared, { traceId: "trace-destructive", chatId: "chat-1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CUSTOM_TOOL_BLOCKED");
});

test("builtin tool names cannot be shadowed by custom registration", () => {
  assert.throws(
    () => registerTool({
      definition: { name: "file.read", description: "x", inputSchema: { type: "object" } },
      risk: "routine",
      prepare: (call) => ({ call, key: "file.read", digest: "d", preview: "p" }),
      execute: () => ({ ok: true, code: "X", summary: "s" }),
    }),
    /collides with a built-in tool/,
  );
});

test.after(() => toolRegistry.clear());
