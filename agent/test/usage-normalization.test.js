const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeUsage, estimateAiRequestTokens } = require("../dist/context/token-estimate");

const baseRequest = {
  traceId: "usage-test",
  system: "system",
  userMessage: "hello",
  tools: [],
  context: { history: [], runtime: { currentTime: "now", timezone: "UTC", locale: "en" } },
  steps: [],
};

test("Gemini usage normalization keeps image modality and cache separate from local estimates", () => {
  const normalized = normalizeUsage(
    {
      promptTokenCount: 1200,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 100,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 108 }, { modality: "IMAGE", tokenCount: 1092 }],
      cacheTokensDetails: [{ modality: "TEXT", tokenCount: 100 }],
    },
    estimateAiRequestTokens(baseRequest),
    baseRequest,
  );
  assert.equal(normalized.providerReported.inputByModality.IMAGE, 1092);
  assert.equal(normalized.providerReported.inputByModality.TEXT, 108);
  assert.equal(normalized.providerReported.cachedByModality.TEXT, 100);
  assert.equal(normalized.providerReported.inputTokensTotal, 1200);
  assert.equal(normalized.providerReported.cacheReadTokens, 100);
  assert.ok(normalized.providerReported.observedModalities.includes("IMAGE"));
  assert.ok(normalized.providerReported.observedModalities.includes("TEXT"));
  assert.equal(normalized.clientEstimated.textTokens > 0, true);
  assert.deepEqual(normalized.clientEstimated.estimator, {
    name: "chars-per-token-plus-image-bytes",
    version: "1",
    confidence: "low",
  });
});

test("OpenAI usage normalization retains aggregate totals without modality", () => {
  const normalized = normalizeUsage(
    { prompt_tokens: 500, completion_tokens: 30, total_tokens: 530 },
    estimateAiRequestTokens(baseRequest),
    baseRequest,
  );
  assert.equal(normalized.providerReported.inputTokensTotal, 500);
  assert.equal(normalized.providerReported.outputTokens, 30);
  assert.equal(normalized.providerReported.inputByModality, undefined);
  assert.equal(normalized.providerReported.observedModalities, undefined);
  assert.equal(normalized.clientEstimated.imageTokens, 0);
});

test("provider totals are never reverse-engineered into observed text", () => {
  const reqWithImage = {
    ...baseRequest,
    steps: [
      {
        call: { name: "browser", arguments: {} },
        result: { ok: true, code: "BROWSER_SCREENSHOT", summary: "snap" },
        image: { mimeType: "image/png", base64: "x".repeat(768), identity: "sha", byteSize: 768 },
      },
    ],
  };
  const normalized = normalizeUsage(
    { promptTokenCount: 1200, candidatesTokenCount: 20 },
    estimateAiRequestTokens(reqWithImage),
    reqWithImage,
  );
  // The provider total stays verbatim; the client image estimate is separate.
  assert.equal(normalized.providerReported.inputTokensTotal, 1200);
  assert.ok(normalized.clientEstimated.imageTokens > 0);
});

test("rawSummary keeps only token-relevant fields and drops heavy content", () => {
  const normalized = normalizeUsage(
    {
      promptTokenCount: 1200,
      candidatesTokenCount: 20,
      contents: [{ role: "user", parts: [{ inlineData: { data: "BIGBASE64" } }] }],
    },
    estimateAiRequestTokens(baseRequest),
    baseRequest,
  );
  const summary = normalized.providerReported.rawSummary;
  assert.equal(summary.promptTokenCount, 1200);
  assert.equal(summary.candidatesTokenCount, 20);
  assert.equal("contents" in summary, false);
  assert.equal(JSON.stringify(summary).includes("inlineData"), false);
});
