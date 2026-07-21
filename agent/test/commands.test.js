const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const os = require("node:os");

const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const {
  buildCommandCatalog,
  buildCommandEnvironment,
  commandPreviewDigest,
  getRunningTraceId,
  loadCommands,
  previewCommand,
  resolveCwd,
  runTrackedCommand,
  waitForRunningCommandStop,
} = require("../dist/commands");
const { ContextHydrator } = require("../dist/context/hydrator");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");
const {
  getPendingApproval,
  insertChatMessage,
  listRecentCommandRuns,
  listTraceEvents,
} = require("../dist/storage/repositories");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { ApprovalService } = require("../dist/security/approvalService");

test("loadCommands maps command names and aliases from the command catalog", () => {
  const commands = loadCommands();

  assert.deepEqual(commands["bemo.checkout"].argv, ["npm", "run", "-s", "checkout"]);
  assert.equal(commands["/bemo_checkout"].name, "bemo.checkout");
  assert.deepEqual(commands["bemo.late-list"].argv, ["node", "src/workflows/late-timeoff.js", "list"]);
  assert.equal(commands["/bemo_late"].requiresConfirmation, false);
  assert.deepEqual(commands["bemo.create-timeoff"].argv, [
    "node",
    "src/workflows/late-timeoff.js",
    "create",
  ]);
  assert.equal(commands["bemo.create-timeoff"].requiresConfirmation, true);
  assert.equal(commands["bemo.prepare-timeoff"].inputMode, "json-stdin");
  assert.equal(commands["/bemo_checkout"].requiresConfirmation, true);
  assert.equal(commands["/bemo_checkout"].externalSideEffect, true);
  assert.equal(commands["/bemo_run"].requiresConfirmation, true);
  assert.equal(commands["/bemo_run"].externalSideEffect, true);
  assert.deepEqual(commands["shutdown"].argv, ["systemctl", "poweroff"]);
  assert.equal(commands["/shutdown"].name, "shutdown");
  assert.equal(commands["/shutdown"].requiresConfirmation, true);
});

test("configured command cwd resolves to an existing skill directory", () => {
  const commands = loadCommands();
  const bemoCwd = resolveCwd(commands["bemo.checkout"].cwd);

  assert.equal(path.basename(bemoCwd), "bemo");
  assert.equal(fs.existsSync(path.join(bemoCwd, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(bemoCwd, "package.json")), true);
});

test("Router shows an argv command preview before confirmation", async () => {
  const chatId = `test-preview-${Date.now()}`;
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const reply = await router.route({
    traceId: `test-preview-trace-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "test-user",
    text: "/shutdown",
    timestamp: new Date(),
  });

  assert.match(reply, /Executable: systemctl/);
  assert.match(reply, /Args: \["poweroff"\]/);
  assert.match(reply, /Cwd: /);
  assert.match(reply, /Phạm vi: Cho phép chạy Tắt máy tính trong run này\./);
  const match = reply.match(/Approval ID: ([a-f0-9]{8})/);
  assert.ok(match);
  assert.match(reply, new RegExp(`approve ${match[1]} hoặc reject ${match[1]}`));
  const pending = getPendingApproval(match[1], "test-user", chatId);
  assert.ok(pending);
});

test("Router executes a scoped approval bound to the exact action digest", async () => {
  const chatId = `test-digest-confirm-${Date.now()}`;
  const action = {
    name: "test.digest",
    label: "Digest-bound command",
    argv: [process.execPath, "-e", 'process.stdout.write("confirmed-ok")'],
    requiresConfirmation: true,
  };
  const preview = previewCommand(action);
  const digest = commandPreviewDigest(preview);
  const pending = new ApprovalService().create({
    runId: `test-digest-pending-${Date.now()}`,
    principalId: "test-user",
    chatId,
    description: "Run digest-bound command for this test.",
    actionDigest: digest,
    payload: { action, preview },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const reply = await router.route({
    traceId: `test-digest-confirm-trace-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "test-user",
    text: `approve ${pending.short_id}`,
    timestamp: new Date(),
  });

  assert.match(reply, /confirmed-ok/);
  assert.equal(getPendingApproval(pending.short_id, "test-user", chatId)?.status, "approved");
});

test("Router rejects a scoped approval without executing its action", async () => {
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const chatId = `test-short-approval-${Date.now()}`;
  const action = { name: "test.reject", label: "Reject test", argv: [process.execPath, "-e", 'process.stdout.write("must-not-run")'], requiresConfirmation: true };
  const digest = commandPreviewDigest(previewCommand(action));
  const pending = new ApprovalService().create({ runId: `test-reject-${Date.now()}`, principalId: "test-user", chatId, description: "Reject this test action.", actionDigest: digest, payload: { action }, expiresAt: new Date(Date.now() + 120000).toISOString() });
  const reply = await router.route({ traceId: `test-reject-trace-${Date.now()}`, provider: "telegram", chatId, userId: "test-user", text: `reject ${pending.short_id}`, timestamp: new Date() });
  assert.match(reply, /Đã từ chối/);
  assert.equal(getPendingApproval(pending.short_id, "test-user", chatId)?.status, "rejected");
});

test("Router rejects mismatched tokens and changed pending actions", async () => {
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const action = {
    name: "test.digest-mismatch",
    label: "Digest mismatch",
    argv: [process.execPath, "-e", 'process.stdout.write("must-not-run")'],
    requiresConfirmation: true,
  };
  const preview = previewCommand(action);
  const digest = commandPreviewDigest(preview);
  const mismatchChat = `test-digest-mismatch-${Date.now()}`;
  const mismatch = new ApprovalService().create({ runId: "test-digest-mismatch-pending", principalId: "test-user", chatId: mismatchChat, description: "Mismatch test.", actionDigest: digest, payload: { action, preview }, expiresAt: new Date(Date.now() + 120000).toISOString() });

  const mismatchReply = await router.route({
    traceId: `test-digest-mismatch-trace-${Date.now()}`,
    provider: "telegram",
    chatId: mismatchChat,
    userId: "test-user",
    text: "approve 00000000",
    timestamp: new Date(),
  });
  assert.match(mismatchReply, /không tồn tại|không còn hợp lệ/);
  assert.equal(getPendingApproval(mismatch.short_id, "test-user", mismatchChat)?.status, "pending");

  const changedChat = `test-digest-changed-${Date.now()}`;
  const changed = new ApprovalService().create({ runId: "test-digest-changed-pending", principalId: "test-user", chatId: changedChat, description: "Changed action test.", actionDigest: digest, payload: { action: { ...action, argv: [process.execPath, "-e", 'process.stdout.write("changed")'] }, preview }, expiresAt: new Date(Date.now() + 120000).toISOString() });
  const changedReply = await router.route({
    traceId: `test-digest-changed-trace-${Date.now()}`,
    provider: "telegram",
    chatId: changedChat,
    userId: "test-user",
    text: `approve ${changed.short_id}`,
    timestamp: new Date(),
  });
  assert.match(changedReply, /không tồn tại|action đã thay đổi|không còn hợp lệ/);
  assert.equal(getPendingApproval(changed.short_id, "test-user", changedChat)?.status, "invalidated");
});

test("SQLite schema initializes and traced command runs persist", async () => {
  const traceId = `test_${Date.now()}`;
  const result = await runTrackedCommand({
    traceId,
    chatId: "test-chat",
    action: {
      name: "test.success",
      label: "Test tracked success",
      argv: [process.execPath, "-e", 'process.stdout.write("tracked-ok")'],
      requiresConfirmation: false,
    },
    defaultTimeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0);
  const run = listRecentCommandRuns("test-chat", 20).find((row) => row.trace_id === traceId);
  assert.ok(run);
  assert.equal(run.status, "success");
  assert.match(run.output_tail, /tracked-ok/);

  const events = listTraceEvents(traceId, 20).map((event) => event.event);
  assert.ok(events.includes("command.started"));
  assert.ok(events.includes("command.completed"));
});

test("tracked command preserves non-zero exit code and stderr output", async () => {
  const result = await runTrackedCommand({
    traceId: `test-failure-${Date.now()}`,
    chatId: "test-chat",
    action: {
      name: "test.failure",
      label: "Test tracked failure",
      argv: [process.execPath, "-e", 'process.stderr.write("agent-fail"); process.exit(7)'],
      requiresConfirmation: false,
    },
    defaultTimeoutMs: 5000,
  });

  assert.equal(result.exitCode, 7);
  assert.match(result.output, /agent-fail/);
});

test("permission policy defaults to allow, prompts for sensitive paths, and denies destructive commands", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-policy-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const workspace = path.join(tmp, "workspace");
  const writable = path.join(workspace, "notes");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(writable, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, "escape"));

  const policy = new PermissionPolicy({
    workspaceRoot: workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [writable],
    deniedPaths: [],
  });

  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, "README.md") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, ".env") }).reasonCode, "CONFIRMATION_REQUIRED");
  assert.equal(policy.evaluate({ kind: "file.write", path: path.join(writable, "new.md") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "file.write", path: path.join(workspace, "other.md") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "file.write", path: path.join(workspace, "escape", "new.md") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, ".git", "config") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, "node_modules", "pkg") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, "credentials.json") }).reasonCode, "CONFIRMATION_REQUIRED");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(outside, "note.md") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "command.run", commandId: "destroy", executable: "rm", args: ["-rf", "/"], cwd: workspace, requiresConfirmation: false, externalSideEffect: false }).outcome, "deny");
  assert.equal(
    policy.evaluate({
      kind: "command.run",
      commandId: "external.write",
      executable: "example",
      args: [],
      cwd: workspace,
      requiresConfirmation: false,
      externalSideEffect: true,
    }).reasonCode,
    "CONFIRMATION_REQUIRED",
  );
  const installNginx = {
    kind: "command.run",
    commandId: "install-nginx",
    executable: "sudo",
    args: ["apt-get", "install", "-y", "nginx"],
    cwd: workspace,
    requiresConfirmation: false,
    externalSideEffect: false,
  };
  assert.equal(policy.evaluate(installNginx).reasonCode, "CONFIRMATION_REQUIRED");
  assert.equal(
    policy.evaluate(installNginx, { userIntent: "Hãy cài Nginx và cấu hình reverse proxy." }).outcome,
    "allow",
  );
  assert.equal(
    policy.evaluate(installNginx, { userIntent: "Hãy xem trạng thái Nginx." }).reasonCode,
    "CONFIRMATION_REQUIRED",
  );
});

test("tracked commands allow an in-scope cwd and still require approval for marked impact", async () => {
  const result = await runTrackedCommand({ traceId: `test-policy-cwd-${Date.now()}`, chatId: "test-chat", action: { name: "test.outside", label: "Outside workspace", cwd: os.tmpdir(), argv: [process.execPath, "-e", 'process.stdout.write("allowed")'], requiresConfirmation: false } });
  assert.match(result.output, /allowed/);

  await assert.rejects(
    runTrackedCommand({
      traceId: `test-policy-confirm-${Date.now()}`,
      chatId: "test-chat",
      action: {
        name: "test.confirm",
        label: "Needs confirmation",
        argv: [process.execPath, "-e", 'process.stdout.write("must-not-run")'],
        requiresConfirmation: true,
      },
    }),
    /CONFIRMATION_REQUIRED/,
  );
});

test("pending approval records expiry and stays bound to its owner", () => {
  const chatId = `test-chat-${Date.now()}`;
  const pending = new ApprovalService().create({ runId: "trace-confirm", principalId: "test-user", chatId, description: "Expired approval.", actionDigest: "a".repeat(64), payload: { ok: true }, expiresAt: new Date(Date.now() - 1).toISOString() });
  const stored = getPendingApproval(pending.short_id, "test-user", chatId);
  assert.ok(stored);
  assert.equal(stored.description, "Expired approval.");
  const wrongOwner = getPendingApproval(pending.short_id, "other-user", chatId);
  assert.equal(wrongOwner, null);
  assert.ok(new Date(stored.expires_at).getTime() < Date.now(), "expiry is in the past");
});

test("multiple scoped approvals can coexist for one chat", () => {
  const chatId = `test-chat-replace-${Date.now()}`;
  const approvals = new ApprovalService();
  const first = approvals.create({ runId: "trace-old", principalId: "test-user", chatId, description: "First action.", actionDigest: "b".repeat(64), payload: { old: true }, expiresAt: new Date(Date.now() + 120000).toISOString() });
  const second = approvals.create({ runId: "trace-new", principalId: "test-user", chatId, description: "Second action.", actionDigest: "c".repeat(64), payload: { newer: true }, expiresAt: new Date(Date.now() + 120000).toISOString() });
  assert.notEqual(first.short_id, second.short_id);
  assert.equal(getPendingApproval(first.short_id, "test-user", chatId)?.run_id, "trace-old");
  assert.equal(getPendingApproval(second.short_id, "test-user", chatId)?.run_id, "trace-new");
});

test("approved action creates a persisted run grant that covers only its action family", () => {
  const service = new ApprovalService();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runId = `grant-run-${suffix}`;
  const principalId = `grant-owner-${suffix}`;
  const chatId = `grant-chat-${suffix}`;
  const digest = `grant-digest-${suffix}`;
  const pending = service.create({
    runId,
    principalId,
    chatId,
    description: "Approve file edits for this run.",
    actionDigest: digest,
    payload: { call: { name: "file.write" } },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.ok(service.resolve({ shortId: pending.short_id, principalId, chatId, actionDigest: digest, approve: true }));
  // Legacy payload (no profile) resolves to a backward-compatible grant whose
  // riskCategories=["approved-action"] (wildcard) and commandHints=["file.write"].
  const fileProfile = { family: "file", riskCategory: "routine", resourceHints: [], commandHints: ["file.write"] };
  const commandProfile = { family: "command", riskCategory: "routine", resourceHints: [], commandHints: ["command.run"] };
  assert.equal(service.covers({ principalId, runId, profile: fileProfile }), true);
  assert.equal(service.covers({ principalId, runId, profile: commandProfile }), false);
});

test("command preview exposes fixed argv, cwd, timeout, and risk", () => {
  const preview = previewCommand({
    name: "test.preview",
    label: "Preview",
    argv: ["node", "script.js", "hello world"],
    cwd: ".",
    timeoutMs: 1234,
    requiresConfirmation: true,
    externalSideEffect: true,
  });

  assert.equal(preview.executable, "node");
  assert.deepEqual(preview.args, ["script.js", "hello world"]);
  assert.equal(preview.cwd, path.resolve(__dirname, ".."));
  assert.equal(preview.timeoutMs, 1234);
  assert.equal(preview.externalSideEffect, true);
});

test("command runner does not interpret shell metacharacters", async (t) => {
  const marker = path.join(os.tmpdir(), `agent-shell-marker-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const literal = `$(touch ${marker})`;
  const result = await runTrackedCommand({
    traceId: `test-no-shell-${Date.now()}`,
    chatId: "test-chat",
    action: {
      name: "test.no-shell",
      label: "No shell",
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", literal],
      requiresConfirmation: false,
    },
  });

  assert.equal(result.output, literal);
  assert.equal(fs.existsSync(marker), false);
});

test("command runner times out with a stable non-zero result", async () => {
  const result = await runTrackedCommand({
    traceId: `test-timeout-${Date.now()}`,
    chatId: "test-chat",
    action: {
      name: "test.timeout",
      label: "Timeout",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      requiresConfirmation: false,
      timeoutMs: 20,
    },
  });

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
});

test("/stop interrupts an active tracked command without waiting for the chat lock", async () => {
  const chatId = `test-stop-${Date.now()}`;
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const traceId = `test-stop-run-${Date.now()}`;
  const run = runTrackedCommand({
    traceId,
    chatId,
    action: {
      name: "test.stop",
      label: "Stoppable command",
      argv: [process.execPath, "-e", 'setInterval(() => {}, 1000)'],
      requiresConfirmation: false,
    },
  });

  for (let i = 0; i < 200 && getRunningTraceId() !== traceId; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(getRunningTraceId(), traceId, "tracked command should have started");
  const reply = await router.route({
    traceId: `test-stop-request-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "test-user",
    text: "/stop",
    timestamp: new Date(),
  });
  await waitForRunningCommandStop(1000);
  const result = await run;

  assert.match(reply, /Đã yêu cầu dừng/);
  assert.equal(result.stopped, true);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(getRunningTraceId(), null);
});

test("minimal command environment excludes undeclared values", () => {
  const env = buildCommandEnvironment({
    PATH: "/test/bin",
    HOME: "/test/home",
    TELEGRAM_BOT_TOKEN: "secret",
    BACKLOG_API_KEY: "secret",
  });

  assert.deepEqual(env, { PATH: "/test/bin", HOME: "/test/home" });
});

test("command catalog fails fast for stale cwd and duplicate aliases", () => {
  assert.throws(
    () => buildCommandCatalog({
      allow: [{
        name: "stale",
        label: "Stale",
        cwd: path.join(os.tmpdir(), `missing-${Date.now()}`),
        argv: ["node"],
      }],
    }),
    /stale cwd/,
  );

  assert.throws(
    () => buildCommandCatalog({
      allow: [
        { name: "one", label: "One", aliases: ["/same"], argv: ["node"] },
        { name: "two", label: "Two", aliases: ["/same"], argv: ["node"] },
      ],
    }),
    /Duplicate command name or alias/,
  );
});

test("ContextHydrator respects dynamic context budget marker", () => {
  const registry = new SkillRegistry(path.join(__dirname, "..", "..", "skills"));
  const hydrator = new ContextHydrator(registry);
  const context = {
    message: {
      traceId: "trace-context",
      provider: "telegram",
      chatId: "chat",
      userId: "user",
      text: "bemo lỗi vừa rồi",
      timestamp: new Date(),
    },
    prompt: {
      history: [],
      runtime: { currentTime: "2026-07-10T16:35:14", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" },
      selectedSkill: {
        slug: "test",
        name: "Test",
        description: "Test skill",
        instructions: "x".repeat(30 * 1024),
      },
    },
  };

  assert.match(hydrator.toPromptSections(context), /\[truncated: dynamic context exceeded 24KB\]/);
});

test("ContextHydrator builds a minimal, redacted prompt for general conversation", () => {
  const registry = new SkillRegistry(path.join(__dirname, "..", "..", "skills"));
  const hydrator = new ContextHydrator(registry);
  const chatId = `safe-context-${Date.now()}`;
  const currentTraceId = `safe-context-current-${Date.now()}`;
  insertChatMessage({
    chatId,
    userId: "agent",
    role: "assistant",
    content: "Tác vụ cần xác nhận.\nExecutable: systemctl\nArgs: [\"poweroff\"]\nCwd: /private\nApproval: secret-token",
    traceId: "previous-trace",
  });
  insertChatMessage({
    chatId,
    userId: "user",
    role: "user",
    content: "hôm nay là thứ mấy",
    traceId: currentTraceId,
  });

  const prompt = hydrator.hydrate({
    traceId: currentTraceId,
    provider: "telegram",
    chatId,
    userId: "user",
    text: "hôm nay là thứ mấy",
    timestamp: new Date("2026-07-10T18:30:00.000Z"),
  }).prompt;

  assert.deepEqual(prompt.capabilityRoute.capabilities, []);
  assert.equal(prompt.selectedSkill, undefined);
  assert.deepEqual(prompt.runtime, {
    currentTime: "2026-07-11T01:30:00",
    timezone: "Asia/Ho_Chi_Minh",
    locale: "vi-VN",
  });
  assert.equal(prompt.history.length, 1);
  assert.match(prompt.history[0].content, /Tác vụ cần xác nhận/);
  assert.doesNotMatch(prompt.history[0].content, /Executable|Args|Cwd|Approval|secret-token/);
});

test("ContextHydrator isolates desktop requests from stale chat tool protocol", () => {
  const registry = new SkillRegistry(path.join(__dirname, "..", "..", "skills"));
  const chatId = `desktop-context-${Date.now()}`;
  insertChatMessage({ chatId, userId: "user", role: "user", content: "approve deadbeef", traceId: "old-approval" });
  insertChatMessage({ chatId, userId: "agent", role: "assistant", content: '```json\n{"toolCall":{"name":"computer","arguments":{"action":"left_click"}}}\n```', traceId: "old-raw" });
  insertChatMessage({ chatId, userId: "user", role: "user", content: "tạo file cũ", traceId: "old-task" });
  const prompt = new ContextHydrator(registry).hydrate({
    provider: "telegram", chatId, userId: "user", text: "Mở VS Code", traceId: "desktop-now", timestamp: new Date(),
  }).prompt;
  assert.deepEqual(prompt.history, []);
  assert.deepEqual(prompt.capabilityRoute.capabilities, ["desktop-observe"]);
});
