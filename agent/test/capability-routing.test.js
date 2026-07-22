const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveCapabilityRoute } = require("../dist/context/capability-routing");
const { ToolExecutor } = require("../dist/tools/executor");
const { estimateAiRequestTokens } = require("../dist/context/token-estimate");

const now = new Date("2026-07-17T10:00:00.000Z");

test("general and low-confidence requests expose no schemas", () => {
  const general = resolveCapabilityRoute({ text: "bạn là ai", traceId: "general", now });
  const ambiguous = resolveCapabilityRoute({ text: "hmm", traceId: "ambiguous", now });
  const executor = new ToolExecutor();
  assert.deepEqual(general.route.capabilities, []);
  assert.deepEqual(ambiguous.route.capabilities, []);
  assert.deepEqual(executor.definitions(general.route), []);
  assert.equal(estimateAiRequestTokens({ traceId: "general", system: "x", context: { history: [], runtime: {}, capabilityRoute: general.route }, userMessage: "bạn là ai", tools: [], steps: [] }).toolSchemas, 0);
});

test("hard signals expose only reviewed capability subsets", () => {
  const executor = new ToolExecutor();
  const file = resolveCapabilityRoute({ text: "đọc file README.md", traceId: "file", now }).route;
  const write = resolveCapabilityRoute({ text: "sửa file README.md", traceId: "write", now }).route;
  const web = resolveCapabilityRoute({ text: "mở https://example.com", traceId: "web", now }).route;
  assert.deepEqual(executor.definitions(file).map((tool) => tool.name), ["file.exists", "file.list", "file.read"]);
  assert.deepEqual(executor.definitions(write).map((tool) => tool.name), ["file.exists", "file.list", "file.mkdir", "file.patch", "file.read", "file.write"]);
  assert.deepEqual(executor.definitions(web).map((tool) => tool.name), ["browser", "web.capture"]);
});

test("active lease supports elliptical continuation but expires and clears on a new general question", () => {
  const first = resolveCapabilityRoute({ text: "mở https://example.com", traceId: "web", now });
  const continued = resolveCapabilityRoute({ text: "click cái thứ hai", traceId: "next", now: new Date(now.getTime() + 1000), activeLease: first.lease });
  const general = resolveCapabilityRoute({ text: "bạn là ai", traceId: "general", now, activeLease: first.lease });
  const expired = resolveCapabilityRoute({ text: "click cái thứ hai", traceId: "expired", now: new Date(now.getTime() + 16 * 60 * 1000), activeLease: first.lease });
  assert.equal(continued.route.continuation, "continued");
  assert.deepEqual(continued.route.capabilities, ["web"]);
  assert.deepEqual(general.route.capabilities, []);
  assert.equal(general.lease, null);
  assert.deepEqual(expired.route.capabilities, []);
  assert.equal(expired.lease, null);
});

test("elliptical/ambiguous follow-up inherits the active lease phrasing-agnostically", () => {
  const first = resolveCapabilityRoute({ text: "mở https://example.com", traceId: "web", now });
  // "chụp lại ảnh đó một lần nữa" matches no WEB/DESKTOP keyword (rt-u026-3 regression):
  // it must still inherit the active web lease rather than resolve to empty tools.
  const recapture = resolveCapabilityRoute({ text: "chụp lại ảnh đó một lần nữa", traceId: "next", now: new Date(now.getTime() + 1000), activeLease: first.lease });
  assert.equal(recapture.route.continuation, "continued");
  assert.deepEqual(recapture.route.capabilities, ["web"]);
  assert.equal(recapture.route.selectionReason, "active scope continuation");
  // A neutral follow-up with no keyword at all also continues (phrasing-agnostic).
  const vague = resolveCapabilityRoute({ text: "xem sao nhé", traceId: "vague", now: new Date(now.getTime() + 2000), activeLease: first.lease });
  assert.equal(vague.route.continuation, "continued");
  assert.deepEqual(vague.route.capabilities, ["web"]);
  // No active lease → the fallback never fires; still empty.
  const noLease = resolveCapabilityRoute({ text: "chụp lại ảnh đó một lần nữa", traceId: "none", now });
  assert.deepEqual(noLease.route.capabilities, []);
});

test("file-write elevation is explicit and visibility is immutable per snapshot", () => {
  const executor = new ToolExecutor();
  const read = resolveCapabilityRoute({ text: "đọc file notes.txt", traceId: "read", now });
  const elevated = resolveCapabilityRoute({ text: "sửa nó đi", traceId: "write", now, activeLease: read.lease });
  const snapshot = executor.visibleSnapshot(read.route);
  assert.deepEqual(elevated.route.capabilities, ["file-write", "file-read"]);
  assert.throws(() => executor.prepare({ name: "file.write", arguments: { path: "/tmp/a", content: "x" } }, "snapshot", executor.definitions(read.route)), /Unknown tool/);
  assert.equal(snapshot.names.includes("file.write"), false);
});
