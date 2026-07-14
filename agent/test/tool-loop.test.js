const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { AiRouter } = require("../dist/brain/router");
const { validateAiResponse } = require("../dist/brain/provider");
const { GeminiProvider } = require("../dist/brain/providers/gemini");
const { aiInteractionDir, aiInteractionIndex } = require("../dist/config/paths");
const { buildCommandCatalog } = require("../dist/commands");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { getPendingApproval, listRunSteps } = require("../dist/storage/repositories");
const { ToolExecutor } = require("../dist/tools/executor");
const { ToolGateway } = require("../dist/tools/gateway");
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
  assert.throws(() => validateAiResponse({ text: "ok", extra: true }), /unsupported fields/);
  assert.throws(() => validateAiResponse({ toolCall: { name: "file.read", arguments: [] } }), /arguments/);
});

test("GeminiProvider sends system instructions, role history, and structured output config", async () => {
  const provider = new GeminiProvider("test-key", "test-model");
  let request;
  provider.client.models.generateContent = async (input) => {
    request = input;
    return { text: '{"text":"ok"}' };
  };

  const response = await provider.complete({
    traceId: "gemini-provider-contract",
    system: "system policy",
    userMessage: "current question",
    context: {
      history: [
        { role: "user", content: "older question" },
        { role: "assistant", content: "older answer" },
      ],
      runtime: { currentTime: "2026-07-11T01:30:00", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" },
    },
    tools: [],
    steps: [],
  });

  assert.equal(response.text, "ok");
  assert.equal(request.config.systemInstruction, "system policy");
  assert.equal(request.config.responseMimeType, "application/json");
  assert.equal(request.contents[0].role, "user");
  assert.equal(request.contents[1].role, "model");
  const payload = JSON.parse(request.contents[2].parts[0].text);
  assert.equal(payload.userMessage, "current question");
  assert.deepEqual(payload.runtime, {
    currentTime: "2026-07-11T01:30:00",
    timezone: "Asia/Ho_Chi_Minh",
    locale: "vi-VN",
  });
  const index = fs.readFileSync(aiInteractionIndex, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.traceId === "gemini-provider-contract")
    .slice(-2);
  assert.deepEqual(index.map((record) => record.direction), ["request", "response"]);
  const records = [...new Set(index.map((record) => record.file))]
    .flatMap((file) => fs.readFileSync(path.join(aiInteractionDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)))
    .filter((record) => record.traceId === "gemini-provider-contract")
    .slice(-2);
  assert.deepEqual(records.map((record) => record.direction), ["request", "response"]);
  assert.equal(records[0].payload.model, "test-model");
  assert.equal(records[1].payload.text, '{"text":"ok"}');
});

test("GeminiProvider uses native function calls when tools are available", async () => {
  const provider = new GeminiProvider("test-key", "test-model");
  let request;
  provider.client.models.generateContent = async (input) => {
    request = input;
    return { functionCalls: [{ name: "default_api:computer", args: { action: "screenshot" } }] };
  };

  const response = await provider.complete({
    traceId: "gemini-native-tool",
    system: "system policy",
    userMessage: "capture screen",
    context: { history: [], runtime: { currentTime: "2026-07-13T10:00:00", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" } },
    tools: [{
      name: "computer",
      description: "Capture or control the desktop.",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["screenshot"] } }, required: ["action"], additionalProperties: false },
    }],
    steps: [],
  });

  assert.deepEqual(response.toolCall, { name: "computer", arguments: { action: "screenshot" } });
  assert.equal(request.config.responseMimeType, undefined);
  assert.equal(request.config.tools[0].functionDeclarations[0].name, "computer");
  assert.deepEqual(request.config.tools[0].functionDeclarations[0].parametersJsonSchema.required, ["action"]);
  assert.doesNotMatch(request.config.systemInstruction, /Return strict JSON/);
  assert.match(request.config.systemInstruction, /native function directly/);
  assert.doesNotMatch(request.contents.at(-1).parts[0].text, /availableTools/);
});

test("GeminiProvider recovers a mistakenly printed tool envelope instead of sending it to the user", async () => {
  const provider = new GeminiProvider("test-key", "test-model");
  provider.client.models.generateContent = async () => ({
    text: '```json\n{"toolCall":{"name":"default_api:computer","arguments":{"action":"screenshot"}}}\n```',
  });
  const response = await provider.complete({
    traceId: "gemini-raw-tool", system: "system", userMessage: "capture",
    context: { history: [], runtime: { currentTime: "2026-07-13T10:00:00", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" } },
    tools: [{ name: "computer", description: "computer", inputSchema: { type: "object", properties: {}, additionalProperties: false } }], steps: [],
  });
  assert.deepEqual(response.toolCall, { name: "computer", arguments: { action: "screenshot" } });
});

test("GeminiProvider injects only the latest tool screenshot as inline media", async () => {
  const provider = new GeminiProvider("test-key", "test-model");
  let request;
  provider.client.models.generateContent = async (input) => { request = input; return { text: "done" }; };
  await provider.complete({
    traceId: "gemini-image-context", system: "system", userMessage: "continue",
    context: { history: [], runtime: { currentTime: "2026-07-13T10:00:00", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" } },
    tools: [{ name: "computer", description: "computer", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    steps: [{ call: { name: "computer", arguments: { action: "screenshot" } }, result: { ok: true }, image: { mimeType: "image/png", base64: "aGVsbG8=", identity: "hash", byteSize: 5 } }],
  });
  assert.equal(request.contents.at(-1).parts[1].inlineData.data, "aGVsbG8=");
  assert.doesNotMatch(request.contents.at(-1).parts[0].text, /aGVsbG8=/);
});

test("AiRouter retries transient provider failures at most twice", async () => {
  let calls = 0;
  const delays = [];
  const provider = {
    async complete() {
      calls += 1;
      if (calls < 3) throw new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}');
      return { text: "recovered" };
    },
  };
  const router = new AiRouter({
    provider,
    providerName: "fake",
    model: "fake",
    systemPrompt: "test",
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  const response = await router.complete("provider-retry", "context", "hello");

  assert.equal(response.text, "recovered");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test("AiRouter does not retry permanent provider failures", async () => {
  let calls = 0;
  const provider = {
    async complete() {
      calls += 1;
      throw new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}');
    },
  };
  const router = new AiRouter({
    provider,
    providerName: "fake",
    model: "fake",
    systemPrompt: "test",
    sleep: async () => assert.fail("Permanent provider errors must not be retried."),
  });

  await assert.rejects(() => router.complete("provider-permanent", "context", "hello"), /400/);
  assert.equal(calls, 1);
});

test("ToolExecutor validates structured command input and sends JSON over stdin", async (t) => {
  const root = workspace(t);
  const executor = executorFor(root, path.join(root, "effect.txt"));
  const gateway = new ToolGateway(executor);
  const call = {
    name: "command.test.prepare",
    arguments: { skipDates: ["2026-07-01"] },
  };
  const prepared = gateway.prepare(call, "tool-input");
  const result = await gateway.execute(prepared, {
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

test("ToolGateway evaluates a file write before execution without mutating during prepare", async (t) => {
  const root = workspace(t);
  const target = path.join(root, "prepared-only.txt");
  const gateway = new ToolGateway();
  const prepared = gateway.prepare({
    name: "file.write",
    arguments: { path: target, content: "written only after execute" },
  }, "gateway-file-prepare");

  assert.equal(prepared.blocked, undefined);
  assert.equal(prepared.requiresConfirmation, false);
  assert.equal(fs.existsSync(target), false);

  const result = await gateway.execute(prepared, {
    traceId: "gateway-file-execute",
    chatId: "gateway-file-chat",
  });
  assert.equal(result.code, "FILE_WRITTEN");
  assert.equal(fs.readFileSync(target, "utf8"), "written only after execute");
});

test("ToolGateway runs arbitrary argv commands and denies clearly destructive shell input", async (t) => {
  const root = workspace(t);
  const gateway = new ToolGateway();
  const prepared = gateway.prepare({
    name: "command.run",
    arguments: {
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("generic-command-ok")'],
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    },
  }, "gateway-command-prepare");
  assert.equal(prepared.requiresConfirmation, false);
  const result = await gateway.execute(prepared, { traceId: "gateway-command-execute", chatId: "gateway-command-chat" });
  assert.equal(result.code, "COMMAND_COMPLETED");
  assert.match(result.data.output, /generic-command-ok/);

  const destructive = gateway.prepare({
    name: "command.run",
    arguments: { shellCommand: "rm -rf /", cwd: root },
  }, "gateway-command-deny");
  assert.equal(destructive.blocked?.code, "DENIED_PATH");
});

test("ToolExecutor refuses direct execution without a ToolGateway authorization", async (t) => {
  const root = workspace(t);
  const executor = new ToolExecutor();
  const prepared = executor.prepare({
    name: "command.run",
    arguments: { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root },
  }, "executor-direct-deny");
  const result = await executor.execute(prepared, { traceId: "executor-direct-deny", chatId: "executor-direct-chat" });
  assert.equal(result.code, "TOOL_GATEWAY_REQUIRED");
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
      if (input.steps.length === 1) return { toolCall: { name: "command.test.create", arguments: plan } };
      assert.equal(input.userMessage, "prepare then create");
      assert.equal(input.steps[1].result.code, "COMMAND_COMPLETED");
      return { text: "continued after confirmation" };
    },
  };
  const loop = new AgentToolLoop(
    new AiRouter({ provider, providerName: "fake", model: "fake", systemPrompt: "test" }),
    new ToolGateway(executor),
  );
  const input = message("prepare then create", `compose-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let replyMarkup;

  const preview = await loop.run(input, "context", (markup) => {
    replyMarkup = markup;
  });
  const shortId = preview.match(/Approval ID: ([a-f0-9]{8})/)[1];
  const pending = getPendingApproval(shortId, input.userId, input.chatId);

  assert.match(preview, /test\.create cần xác nhận/);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(pending);
  assert.deepEqual(replyMarkup, {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `approve ${shortId}` },
      { text: "❌ Reject", callback_data: `reject ${shortId}` },
    ]],
  });
  const confirmed = await loop.consumeScopedApproval({
    ...input,
    text: `approve ${shortId}`,
    traceId: `${input.traceId}-confirm`,
  });

  assert.equal(confirmed, "continued after confirmation");
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), {
    skipDates: ["2026-07-01"],
  });
  const persisted = listRunSteps(input.traceId);
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted.map((step) => step.tool_name), ["command.test.prepare", "command.test.create"]);
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
    new ToolGateway(new ToolExecutor()),
  );

  assert.equal(await loop.run(message("do unsafe thing", "unknown"), "context"), "rejected safely");
});

test("AgentToolLoop stops after one retry of the identical failure", async () => {
  let calls = 0;
  const provider = {
    async complete() {
      calls += 1;
      return { toolCall: { name: "file.read", arguments: { path: "missing.txt" } } };
    },
  };
  const failingExecutor = {
    definitions: () => [],
    prepare: (call) => ({
      call,
      key: call.name,
      digest: "test-digest",
      preview: call.name,
      requiresConfirmation: false,
    }),
    execute: async () => ({
      ok: false,
      code: "TEST_FAILURE",
      summary: "The test tool failed.",
    }),
  };
  const loop = new AgentToolLoop(
    new AiRouter({ provider, providerName: "fake", model: "fake", systemPrompt: "test" }),
    failingExecutor,
  );

  const response = await loop.run(message("repeat unsafe thing", "repeated-failure"), "context");

  assert.equal(calls, 2);
  assert.match(response, /dừng sau 2 lần lỗi lặp lại/);
  assert.match(response, /file\.read/);
  assert.match(response, /TEST_FAILURE/);
});
