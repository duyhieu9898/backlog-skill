const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const { ApprovalService } = require("../dist/security/approvalService");
const { createApprovalGrant, revokeApprovalGrant, nowIso } = require("../dist/storage/repositories");

function unique(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Create a grant directly and return its id; bypasses resolve() to test matching in isolation. */
function makeGrant({ principalId, scope = "run", runId, sessionId, scheduleId, riskCategories, commandHints, resourceHints, expiresAt }) {
  const id = crypto.randomUUID();
  createApprovalGrant({
    id,
    principalId,
    description: "test grant",
    scope,
    runId,
    sessionId,
    scheduleId,
    riskCategories,
    resourceHints,
    commandHints,
    expiresAt,
  });
  return id;
}

const fileWriteProfile = { family: "file", riskCategory: "sensitive", resourceHints: ["/tmp/secret.txt"], commandHints: ["file.write"] };
const commandRunProfile = { family: "command", riskCategory: "system-impact", resourceHints: ["/srv/app"], commandHints: ["command.run"] };

test("covers an equivalent in-scope action (same resource, run scope)", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  makeGrant({ principalId, runId, riskCategories: ["sensitive"], commandHints: ["file.write"], resourceHints: ["/tmp/secret.txt"] });
  assert.equal(service.covers({ principalId, runId, profile: fileWriteProfile }), true);
});

test("does not cover a different resource", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  makeGrant({ principalId, runId, riskCategories: ["sensitive"], commandHints: ["file.write"], resourceHints: ["/tmp/secret.txt"] });
  assert.equal(service.covers({ principalId, runId, profile: { ...fileWriteProfile, resourceHints: ["/tmp/other.txt"] } }), false);
});

test("does not cover a higher risk than the grant allows", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  makeGrant({ principalId, runId, riskCategories: ["sensitive"], commandHints: ["file.write"], resourceHints: ["/tmp/secret.txt"] });
  assert.equal(service.covers({ principalId, runId, profile: { ...fileWriteProfile, riskCategory: "destructive" } }), false);
});

test("session-scoped grant covers across different runs in that session", () => {
  const principalId = unique("owner");
  const sessionId = unique("session");
  const service = new ApprovalService();
  makeGrant({ principalId, scope: "session", sessionId, riskCategories: ["sensitive"], commandHints: ["file.write"], resourceHints: ["/tmp/secret.txt"] });
  assert.equal(service.covers({ principalId, runId: unique("run-a"), sessionId, profile: fileWriteProfile }), true);
  assert.equal(service.covers({ principalId, runId: unique("run-b"), sessionId, profile: fileWriteProfile }), true);
});

test("revoked grant does not cover", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  const grantId = makeGrant({ principalId, runId, riskCategories: ["sensitive"], commandHints: ["file.write"], resourceHints: ["/tmp/secret.txt"] });
  service.revoke(grantId);
  assert.equal(service.covers({ principalId, runId, profile: fileWriteProfile }), false);
});

test("expired grant does not cover", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  makeGrant({ principalId, runId, riskCategories: ["sensitive"], commandHints: ["file.write"], resourceHints: ["/tmp/secret.txt"], expiresAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(service.covers({ principalId, runId, profile: fileWriteProfile }), false);
});

test("backward-compat: legacy grant (approved-action wildcard, no resourceHints) still covers same family", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  // Old-style grant written before P1.2: wildcard risk, commandHints only, no resourceHints.
  makeGrant({ principalId, runId, riskCategories: ["approved-action"], commandHints: ["file.write"], resourceHints: undefined });
  assert.equal(service.covers({ principalId, runId, profile: fileWriteProfile }), true);
  // But a different command family is still not covered.
  assert.equal(service.covers({ principalId, runId, profile: commandRunProfile }), false);
});

test("wildcard grant covers any action", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  makeGrant({ principalId, runId, riskCategories: ["*"], commandHints: ["*"] });
  assert.equal(service.covers({ principalId, runId, profile: fileWriteProfile }), true);
  assert.equal(service.covers({ principalId, runId, profile: commandRunProfile }), true);
});

test("command grant matches by cwd resource hint", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  makeGrant({ principalId, runId, riskCategories: ["system-impact"], commandHints: ["command.run"], resourceHints: ["/srv/app"] });
  assert.equal(service.covers({ principalId, runId, profile: commandRunProfile }), true);
  assert.equal(service.covers({ principalId, runId, profile: { ...commandRunProfile, resourceHints: ["/srv/other"] } }), false);
});

test("browser action never widens (no commandHints stored on its grant)", () => {
  const principalId = unique("owner");
  const runId = unique("run");
  const service = new ApprovalService();
  // A browser approval resolves to a grant with empty commandHints, so it must
  // not be widened into a general grant covering later browser operations.
  makeGrant({ principalId, runId, riskCategories: ["approved-action"], commandHints: [], resourceHints: undefined });
  const browserProfile = { family: "browser", riskCategory: "approved-action", resourceHints: ["https://example.com"], commandHints: ["browser.act"] };
  assert.equal(service.covers({ principalId, runId, profile: browserProfile }), false);
});
