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

test("sanitizeForLog preserves token-usage metrics but still redacts secrets", () => {
  // Child keys contain "token" (OpenAI *_tokens, Gemini *TokenCount) but are usage
  // metrics, not secrets — they must survive so eval/audit can account for cost.
  const result = sanitizeForLog({
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
    tokenAttribution: { system: 10, history: 4, totalEstimated: 14 },
    api_key: "sk_live_abc",
    token: "session-xyz",
  });
  assert.deepEqual(result.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  assert.deepEqual(result.usageMetadata, { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 });
  assert.deepEqual(result.tokenAttribution, { system: 10, history: 4, totalEstimated: 14 });
  assert.equal(result.api_key, "[redacted]");
  assert.equal(result.token, "[redacted]");
});
