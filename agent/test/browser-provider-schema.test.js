const assert = require("node:assert/strict");
const test = require("node:test");

const { browserDefinition } = require("../dist/tools/executor");
const { normalizeActionEnvelope } = require("../dist/browser/contract");

test("browser provider schema exposes ref preconditions without union features", () => {
  const schema = browserDefinition.inputSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  const serialized = JSON.stringify(schema);
  // No provider-union schema features; the flat envelope is the only shape.
  assert.equal(serialized.includes('"oneOf"'), false);
  assert.equal(serialized.includes('"anyOf"'), false);
  // Ref preconditions are known properties of the nested request envelope.
  const requestProps = schema.properties.request.properties;
  assert.ok("snapshotId" in requestProps, "request schema exposes snapshotId");
  assert.ok("ref" in requestProps, "request schema exposes ref");
});

test("normalizeActionEnvelope rejects malformed provider envelopes at the choke point", () => {
  // click requires snapshotId
  assert.throws(() => normalizeActionEnvelope({ action: "act", request: { kind: "click", ref: "e1" } }), /requires snapshotId/);
  // press must not carry a ref (cross-variant field)
  assert.throws(() => normalizeActionEnvelope({ action: "act", request: { kind: "press", key: "Enter", ref: "e1" } }), /does not accept "ref"/);
  // unknown kind
  assert.throws(() => normalizeActionEnvelope({ action: "act", request: { kind: "unknown" } }), /Unsupported browser action/);
  // a valid envelope passes through unchanged
  const { action, request } = normalizeActionEnvelope({ action: "act", request: { kind: "press", key: "Enter" } });
  assert.equal(action, "act");
  assert.equal(request.kind, "press");
});
