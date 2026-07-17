const assert = require("node:assert/strict");
const test = require("node:test");

const { ContextAssembler } = require("../dist/context/assembler");
const { retrieveMemory, retrieveMemoryFromSources } = require("../dist/context/memory");
const { checkpointFromModelResponse, renderCheckpoint } = require("../dist/context/checkpoint");

test("ContextAssembler selects a recent tail by estimated tokens, not message count", () => {
  const assembler = new ContextAssembler({ recentTailTokens: 30 });
  const entries = [
    { role: "user", content: "a".repeat(20) },
    { role: "assistant", content: "b".repeat(20) },
    { role: "user", content: "recent" },
  ];

  const result = assembler.assemble(entries);

  assert.deepEqual(result.history, [
    { role: "assistant", content: "b".repeat(20) },
    { role: "user", content: "recent" },
  ]);
  assert.equal(result.omittedEntries, 1);
  assert.ok(result.estimatedTokens <= 30);
});

test("ContextAssembler keeps one oversized newest entry rather than returning an empty context", () => {
  const result = new ContextAssembler({ recentTailTokens: 1 }).assemble([
    { role: "user", content: "x".repeat(100) },
  ]);
  assert.equal(result.history.length, 1);
  assert.ok(result.estimatedTokens > 1);
});

test("durable memory retrieval injects only relevant bounded chunks", () => {
  const source = [
    "# MEMORY",
    "- Browser must support managed and CDP profiles.",
    "",
    "- Persisted approvals survive process restart.",
    "",
    "- User prefers Vietnamese responses.",
  ].join("\n");
  const hits = retrieveMemory("approval restart bị lỗi", source, 40);
  assert.deepEqual(hits, ["- Persisted approvals survive process restart."]);
  assert.deepEqual(retrieveMemory("không liên quan", source, 40), []);
});

test("durable memory retrieval can recover a relevant daily flush without injecting unrelated notes", () => {
  const hits = retrieveMemoryFromSources("checkpoint audit", [
    "- User prefers terse replies.",
    "# Working memory\n\n- Decision: keep checkpoint (audit)\n\n- Identifier: US-CTX",
  ], 40);
  assert.deepEqual(hits, ["- Decision: keep checkpoint (audit)"]);
});

test("structured checkpoint parser preserves prior state when a later compaction omits a section", () => {
  const first = checkpointFromModelResponse(JSON.stringify({
    goals: ["finish migration"],
    decisions: [{ decision: "keep transcript", rationale: "audit" }],
    nextSteps: ["add tests"],
  }));
  const second = checkpointFromModelResponse(JSON.stringify({
    completed: ["session isolation"],
    nextSteps: ["run verification"],
  }), first);
  assert.deepEqual(second.goals, ["finish migration"]);
  assert.deepEqual(second.decisions, [{ decision: "keep transcript", rationale: "audit" }]);
  assert.deepEqual(second.completed, ["session isolation"]);
  assert.match(renderCheckpoint(second), /finish migration/);
});
