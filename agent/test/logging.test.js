const assert = require("node:assert/strict");
const test = require("node:test");

const { redactString, sanitizeForLog } = require("../dist/logging/logger");

test("log redaction removes secret values from keys and common credential strings", () => {
  assert.equal(redactString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: [redacted] [redacted]");
  assert.equal(redactString("token=super-secret-value"), "token=[redacted]");
  assert.equal(redactString("sk_abcdefghijklmnopqrstuvwxyz"), "[redacted]");
  assert.deepEqual(sanitizeForLog({ cookie: "session-value", nested: { password: "dont-log-me" } }), {
    cookie: "[redacted]",
    nested: { password: "[redacted]" },
  });
});
