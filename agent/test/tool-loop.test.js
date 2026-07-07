const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { AiRouter } = require("../dist/brain/router");
const { validateAiResponse } = require("../dist/brain/provider");
const { buildCommandCatalog } = require("../dist/commands");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { getPendingConfirmation } = require("../dist/storage/repositories");
const { ToolExecutor } = require("../dist/tools/executor");
const { FileTools } = require("../dist/tools/files");
const { AgentToolLoop } = require("../dist/tools/loop");

function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, "tool-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function message(text, suffix) {
  return {
    traceId: `tool-loop-trace-${suffix}`,
    provider: "telegram",
    chatId: `tool-loop-chat-${suffix}`,
    userId: "user",
    text,
    timestamp: new Date(),
  };
}

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

test("validateAiResponse enforces one structured outcome", () => {
  assert.deepEqual(validateAiResponse({ text: "ok" }), {
    text: "ok",
    clarification: undefined,
    toolCall: undefined,
    usage: undefined,
  });
  assert.throws(() => validateAiResponse({ text: "ok", clarification: "why" }), /exactly one/);
  assert.throws(() => validateAiResponse({ toolCall: { name: "file.read", arguments: [] } }), /arguments/);
});

test("ToolExecutor validates structured command input and sends JSON over stdin", async (t) => {
  const root = workspace(t);
  const executor = executorFor(root, path.join(root, "effect.txt"));
  const call = {
    name: "command.test.prepare",
    arguments: { skipDates: ["2026-07-01"] },
  };
  const prepared = executor.prepare(call, "tool-input");
  const result = await executor.execute(prepared, {
    traceId: "tool-input",
    chatId: "tool-input-chat",
  });

  assert.equal(prepared.requiresConfirmation, false);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.data.output), call.arguments);
  assert.throws(
    () => executor.prepare({ ...call, arguments: { skipDates: ["01/07/2026"] } }, "bad-input"),
    /YYYY-MM-DD/,
  );
});

test("AgentToolLoop composes a read-only command then pauses at one confirmed effect", async (t) => {
  const root = workspace(t);
  const marker = path.join(root, "effect.txt");
  const executor = executorFor(root, marker);
  const provider = {
    async complete(input) {
      if (input.steps.length === 0) {
        return {
          toolCall: {
            name: "command.test.prepare",
            arguments: { skipDates: ["2026-07-01"] },
          },
        };
      }
      const plan = JSON.parse(input.steps[0].result.data.output);
      return { toolCall: { name: "command.test.create", arguments: plan } };
    },
  };
  const loop = new AgentToolLoop(
    new AiRouter({ provider, providerName: "fake", model: "fake", systemPrompt: "test" }),
    executor,
  );
  const input = message("prepare then create", "compose");

  const preview = await loop.run(input, "context");
  const pending = getPendingConfirmation(input.chatId);

  assert.match(preview, /test\.create cần xác nhận/);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(pending);
  const token = preview.match(/Approval: ([a-f0-9]{12})/)[1];
  const confirmed = await loop.consumeConfirmation({
    ...input,
    text: `confirm test.create ${token}`,
    traceId: `${input.traceId}-confirm`,
  });

  assert.match(confirmed, /Tool completed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), {
    skipDates: ["2026-07-01"],
  });
});

test("AgentToolLoop rejects unknown tools and lets the provider recover", async () => {
  const provider = {
    async complete(input) {
      if (!input.steps.length) return { toolCall: { name: "shell.raw", arguments: {} } };
      assert.equal(input.steps[0].result.code, "INVALID_TOOL_CALL");
      return { text: "rejected safely" };
    },
  };
  const loop = new AgentToolLoop(
    new AiRouter({ provider, providerName: "fake", model: "fake", systemPrompt: "test" }),
    new ToolExecutor(),
  );

  assert.equal(await loop.run(message("do unsafe thing", "unknown"), "context"), "rejected safely");
});
