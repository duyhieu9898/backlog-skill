const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateAction } = require("../dist/browser/action-policy");

const defaultConfig = {
  allowedHosts: [],
  publicNavigation: "allow",
  privateNavigation: "deny",
  consequentialActions: "confirm",
  destructiveActions: "confirm",
};

test("action policy - fill search field allowed", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "fill", ref: "e1", value: "Playwright", snapshotId: "snap1" },
    element: { ref: "e1", role: "textbox", name: "Search", placeholder: "Search here" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "allow");
});

test("action policy - sensitive password input allowed", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "fill", ref: "e1", value: "mypassword", snapshotId: "snap1" },
    element: { ref: "e1", role: "textbox", name: "password", inputType: "password" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "allow"); // sensitive-input is allowed by policy, just flagged/redacted in logs
});

test("action policy - click doc link allowed", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "click", ref: "e1", snapshotId: "snap1" },
    element: { ref: "e1", role: "link", name: "Documentation", text: "Read docs" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "allow");
});

test("action policy - click remove filter allowed", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "click", ref: "e1", snapshotId: "snap1" },
    element: { ref: "e1", role: "button", name: "Remove filter", text: "Remove filter" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "allow"); // remove filter is harmless
});

test("action policy - click submit search allowed", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "click", ref: "e1", snapshotId: "snap1" },
    element: { ref: "e1", role: "button", name: "Submit search" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "allow"); // submit search is allowed
});

test("action policy - click send message requires confirmation", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "click", ref: "e1", snapshotId: "snap1" },
    element: { ref: "e1", role: "button", name: "Send message" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "confirm");
  assert.equal(decision.code, "CONFIRMATION_REQUIRED");
  assert.ok(decision.actionFingerprint);
});

test("action policy - press enter in search box allowed", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "press", key: "Enter" },
    element: { role: "textbox", name: "Search box" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "allow");
});

test("action policy - press enter in message composer requires confirmation", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "press", key: "Enter" },
    element: { role: "textarea", name: "Message Composer" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "confirm");
});

test("action policy - click save profile requires confirmation", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "click", ref: "e1", snapshotId: "snap1" },
    element: { ref: "e1", role: "button", name: "Save Profile" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "confirm");
});

test("action policy - click delete account requires confirmation", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "click", ref: "e1", snapshotId: "snap1" },
    element: { ref: "e1", role: "button", name: "Delete account permanently" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "confirm");
});

test("action policy - click how to delete account link allowed", () => {
  const context = {
    sessionId: "s1",
    runId: "r1",
    profile: "p1",
    targetId: "t1",
    url: "https://google.com",
    action: { kind: "click", ref: "e1", snapshotId: "snap1" },
    element: { ref: "e1", role: "link", name: "How to delete account" },
  };

  const decision = evaluateAction(context, defaultConfig);
  assert.equal(decision.decision, "allow"); // link navigation is allowed
});
