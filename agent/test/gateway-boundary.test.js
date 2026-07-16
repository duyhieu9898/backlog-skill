// ADR 0017 P2.2 — locks ToolGateway as the SOLE tool-execution boundary.
//
// The audit found no bypass: every side-effecting primitive (command spawn,
// file write/patch, browser, desktop/X11, web.capture, custom tool) is reachable
// only through ToolExecutor.execute, which hard-requires `gatewayAuthorized`,
// and that flag is set in exactly one place (ToolGateway.execute). These tests
// make that invariant self-checking: a future change that adds a second
// authorized call site, a direct runTrackedCommand caller outside the executor,
// or an executable method on the skill registry will fail here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { ToolExecutor } = require("../dist/tools/executor");

const SRC_ROOT = path.join(__dirname, "..", "src");

function readSrcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push({ rel: path.relative(SRC_ROOT, full), source: fs.readFileSync(full, "utf8") });
    }
  };
  walk(SRC_ROOT);
  return out;
}

test("ToolExecutor.execute refuses to run without gateway authorization", async () => {
  const executor = new ToolExecutor();
  const prepared = { call: { name: "file.read", arguments: {} } };

  // The guard fires before any dispatch, so a minimal prepared object is enough.
  const blocked = await executor.execute(prepared, { traceId: "boundary-test", chatId: "c1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "TOOL_GATEWAY_REQUIRED");
});

test("ToolExecutor.execute honors gatewayAuthorized and proceeds past the guard", async () => {
  const executor = new ToolExecutor();
  // A pre-blocked prepared call returns its blocked result immediately after the
  // guard (executor.ts: `if (prepared.blocked) return prepared.blocked`), proving
  // the flag was accepted without executing anything.
  const prepared = {
    call: { name: "file.read", arguments: {} },
    blocked: { ok: false, code: "PRE_BLOCKED", summary: "fixture" },
  };

  const result = await executor.execute(prepared, { traceId: "boundary-test", chatId: "c1", gatewayAuthorized: true });
  assert.equal(result.code, "PRE_BLOCKED");
});

test("`gatewayAuthorized: true` is set in exactly one place: tools/gateway.ts", () => {
  const sites = [];
  for (const file of readSrcFiles()) {
    for (const line of file.source.split("\n")) {
      if (/gatewayAuthorized:\s*true/.test(line)) sites.push(file.rel);
    }
  }
  assert.deepEqual(sites, [path.join("tools", "gateway.ts")], [
    "gatewayAuthorized:true must appear only in tools/gateway.ts. Found:",
    sites.join(", "),
  ].join(" "));
});

test("runTrackedCommand is called from exactly one place: tools/executor.ts", () => {
  const callers = [];
  for (const file of readSrcFiles()) {
    for (const line of file.source.split("\n")) {
      if (/runTrackedCommand\(/.test(line) && !/\bfunction\s+runTrackedCommand\b/.test(line)) {
        callers.push(file.rel);
      }
    }
  }
  assert.deepEqual(callers, [path.join("tools", "executor.ts")], [
    "runTrackedCommand must be called only from tools/executor.ts. Found callers:",
    callers.join(", "),
  ].join(" "));
});

test("skill registry performs no code execution (prompt-only)", () => {
  const registry = readSrcFiles().find((f) => f.rel === path.join("skills", "registry.ts"));
  assert.ok(registry, "skills/registry.ts exists");
  assert.equal(/child_process/.test(registry.source), false, "registry must not import child_process");
  assert.equal(/\b(execute|spawn|execSync|execFile|fork)\s*\(/.test(registry.source), false, "registry must not define any execution primitive");
});
