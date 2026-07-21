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

test("file-write elevation is explicit and visibility is immutable per snapshot", () => {
  const executor = new ToolExecutor();
  const read = resolveCapabilityRoute({ text: "đọc file notes.txt", traceId: "read", now });
  const elevated = resolveCapabilityRoute({ text: "sửa nó đi", traceId: "write", now, activeLease: read.lease });
  const snapshot = executor.visibleSnapshot(read.route);
  assert.deepEqual(elevated.route.capabilities, ["file-write", "file-read"]);
  assert.throws(() => executor.prepare({ name: "file.write", arguments: { path: "/tmp/a", content: "x" } }, "snapshot", executor.definitions(read.route)), /Unknown tool/);
  assert.equal(snapshot.names.includes("file.write"), false);
});
