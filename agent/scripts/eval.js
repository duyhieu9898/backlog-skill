#!/usr/bin/env node
// CLI eval harness (ADR 0017 follow-on).
//
// Runs a fixed prompt-spec through the REAL CLI (`dist/cli.js --json`) as a black
// box, then aggregates the telemetry each run already emits (trace_events,
// run_steps, runs) into a JSON + markdown report answering: did it succeed? why
// fail/err? why slow? why token-heavy? why wrong? — drillable via traceId.
//
// Each case runs in a subprocess against an ISOLATED eval DB (eval/eval.sqlite,
// via AGENT_DB_FILE) so the production agent.sqlite is untouched. It tests the
// shared core (Router/gateway/AI/tools) that the future TUI will also use, so
// results carry forward without duplication.
//
// Usage: npm run eval [-- --only <id>] [-- --spec <file>]

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const evalDir = path.join(__dirname, "..", "eval");
const reportsDir = path.join(evalDir, "reports");
const dbFile = path.join(evalDir, "eval.sqlite");
const defaultSpec = path.join(evalDir, "prompts.json");
const cliPath = path.join(__dirname, "..", "dist", "cli.js");

// AGENT_DB_FILE must be set BEFORE any dist require (paths.ts resolves sqliteFile
// at module-eval time), mirroring the test-file pattern.
process.env.AGENT_DB_FILE = dbFile;
fs.mkdirSync(reportsDir, { recursive: true });

const { loadEnv } = require("../dist/config/env");
const { agentDir, sqliteFile } = require("../dist/config/paths");
const { getDb, closeDb } = require("../dist/storage/db");
const { listTraceEvents, listRunSteps, getRun } = require("../dist/storage/repositories");

loadEnv(path.join(agentDir, ".env"));
if (sqliteFile !== path.resolve(dbFile)) {
  console.error(`eval: AGENT_DB_FILE did not route sqliteFile to ${dbFile} (got ${sqliteFile}).`);
  process.exit(1);
}

const argv = process.argv.slice(2);
function argFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const specPath = argFlag("--spec") || defaultSpec;
const onlyId = argFlag("--only");

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const cases = (Array.isArray(spec) ? spec : spec.cases).filter((c) => !onlyId || c.id === onlyId);
if (cases.length === 0) {
  console.error(`eval: no cases${onlyId ? ` matching id "${onlyId}"` : ""} in ${specPath}.`);
  process.exit(2);
}

// --- per-case run ----------------------------------------------------------

function runCase(c, index) {
  const env = { ...process.env, AGENT_DB_FILE: dbFile };
  const startedAt = Date.now();
  let stdout = "";
  let exitCode = null;
  let timedOut = false;
  try {
    // Evaluation cases intentionally receive distinct chat/session identities.
    // The shared eval DB remains useful for one report, but must never become
    // working history for a later case.
    const session = `eval-${Date.now()}-${index}-${c.id}`;
    stdout = execFileSync(process.execPath, [cliPath, "--json", "--session", session, c.prompt], {
      cwd: agentDir,
      encoding: "utf8",
      env,
      timeout: c.timeoutMs || 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    exitCode = 0;
  } catch (err) {
    if (err.signal === "SIGTERM" || err.killed) timedOut = true;
    stdout = err.stdout || "";
    exitCode = err.status == null ? null : err.status;
  }
  const totalMs = Date.now() - startedAt;

  let parsed = null;
  try { parsed = JSON.parse(stdout.split("\n").find((l) => l.startsWith("{")) || stdout); } catch { /* CLI did not emit JSON */ }
  const traceId = parsed?.traceId || null;
  return { traceId, exitCode, timedOut, totalMs, parsed };
}

// --- metric aggregation (reuses existing telemetry) ------------------------

function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const prompt = u.prompt_tokens ?? u.promptTokenCount;
  const completion = u.completion_tokens ?? u.candidatesTokenCount;
  const total = u.total_tokens ?? u.totalTokenCount;
  // Thinking/reasoning tokens (hidden inside completion unless surfaced): Gemini
  // thoughtsTokenCount, OpenAI completion_tokens_details.reasoning_tokens.
  const reasoning = u.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? null;
  const thoughts = u.thoughtsTokenCount ?? null;
  if (prompt == null && completion == null && total == null && reasoning == null && thoughts == null) return null;
  return { prompt: prompt ?? null, completion: completion ?? null, total: total ?? null, reasoning, thoughts };
}

function sumUsage(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const add = (x, y) => (x == null || y == null ? (x ?? y ?? null) : x + y);
  return {
    prompt: add(a.prompt, b.prompt),
    completion: add(a.completion, b.completion),
    total: add(a.total, b.total),
    reasoning: add(a.reasoning, b.reasoning),
    thoughts: add(a.thoughts, b.thoughts),
  };
}

function aggregate(traceId, runResult) {
  const events = traceId ? listTraceEvents(traceId, 500) : [];
  const run = traceId ? getRun(traceId) : null;
  const steps = traceId ? listRunSteps(traceId) : [];

  let aiMs = 0;
  let toolMs = 0;
  let tokens = null;
  let provider = null;
  let model = null;
  let tokenAttribution = null;
  const denyReasons = [];
  for (const row of events) {
    const p = safeParse(row.payload_json);
    if (row.event === "ai.response.received") {
      if (typeof p.latencyMs === "number") aiMs += p.latencyMs;
      const u = normalizeUsage(p.usage);
      if (u) tokens = sumUsage(tokens, u);
    } else if (row.event === "gateway.executed") {
      if (typeof p.latencyMs === "number") toolMs += p.latencyMs;
    } else if (row.event === "ai.request.created") {
      provider = provider || p.provider;
      model = model || p.model;
      tokenAttribution = tokenAttribution || p.tokenAttribution || null;
    } else if (row.event === "gateway.decision" && p.outcome === "deny") {
      denyReasons.push(`${p.reasonCode || "DENY"}: ${p.reason || ""}`.trim());
    }
  }

  const toolSteps = steps.map((s) => {
    const result = safeParse(s.result_json);
    return { name: s.tool_name, ok: !!result.ok, code: result.code || null };
  });
  const failedSteps = toolSteps.filter((s) => !s.ok);

  const artifact = runResult.parsed?.artifact
    ? { id: runResult.parsed.artifact.id, mime: runResult.parsed.artifact.mimeType, bytes: runResult.parsed.artifact.byteSize, path: runResult.parsed.artifact.path }
    : null;

  return {
    traceId,
    exitCode: runResult.exitCode,
    timedOut: runResult.timedOut,
    runStatus: run?.status || null,
    totalMs: runResult.totalMs,
    aiMs,
    toolMs,
    aiSteps: events.filter((e) => e.event === "ai.response.received").length,
    toolSteps,
    failedSteps,
    denyReasons,
    artifact,
    tokenUsage: tokens,
    tokenAttribution,
    provider,
    model,
    reply: runResult.parsed?.reply || null,
  };
}

function safeParse(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

// --- auto pass/fail vs spec.expect -----------------------------------------

function evaluate(c, m) {
  const reasons = [];
  const e = c.expect || {};
  if (e.exitCode !== undefined && m.exitCode !== e.exitCode) reasons.push(`exitCode ${m.exitCode} !== ${e.exitCode}`);
  if (e.runStatus && m.runStatus !== e.runStatus) reasons.push(`runStatus ${m.runStatus} !== ${e.runStatus}`);
  if (e.replyContains && !(m.reply || "").includes(e.replyContains)) reasons.push(`reply missing "${e.replyContains}"`);
  if (e.artifactMime && (!m.artifact || m.artifact.mime !== e.artifactMime)) reasons.push(`artifact mime ${m.artifact?.mime || "none"} !== ${e.artifactMime}`);
  if (e.maxToolSteps !== undefined && m.toolSteps.length > e.maxToolSteps) reasons.push(`toolSteps ${m.toolSteps.length} > ${e.maxToolSteps}`);
  if (m.timedOut) reasons.push("timed out");
  return { pass: reasons.length === 0, reasons };
}

// --- run all + report ------------------------------------------------------

const results = cases.map((c, index) => {
  const runResult = runCase(c, index);
  const metrics = aggregate(runResult.traceId, runResult);
  const verdict = evaluate(c, metrics);
  return { id: c.id, prompt: c.prompt, expect: c.expect || {}, ...metrics, ...verdict };
});

closeDb();

const at = new Date().toISOString();
const stamp = at.replace(/[:.]/g, "-");
const summary = {
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  avgMs: Math.round(results.reduce((s, r) => s + r.totalMs, 0) / (results.length || 1)),
  totalTokens: results.reduce((s, r) => s + (r.tokenUsage?.total || 0), 0),
  provider: results.find((r) => r.provider)?.provider || null,
  model: results.find((r) => r.model)?.model || null,
};

const report = { at, ...summary, cases: results };
const jsonPath = path.join(reportsDir, `${stamp}.json`);
const mdPath = path.join(reportsDir, `${stamp}.md`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(mdPath, renderMarkdown(report));

console.log(`\n eval → ${path.relative(agentDir, jsonPath)} + .md`);
console.log(renderMarkdown(report));

// ---------------------------------------------------------------------------
function renderMarkdown(r) {
  const head = [
    `# Eval ${r.at}`,
    ``,
    `provider: ${r.provider || "?"} | model: ${r.model || "?"}`,
    `Summary: ${r.total} cases — ${r.passed} passed, ${r.failed} failed | avg ${r.avgMs}ms | ${r.totalTokens} tokens`,
    ``,
    `| id | pass | ms | tokens | steps | reason |`,
    `|---|---|---:|---:|---:|---|`,
  ];
  const table = r.cases.map((c) =>
    `| ${c.id} | ${c.pass ? "✅" : "❌"} | ${c.totalMs} | ${c.tokenUsage?.total ?? "-"} | ${c.toolSteps.length} | ${c.reasons.join("; ") || ""} |`,
  );
  const detail = r.cases.map((c) => [
    ``,
    `## ${c.id}`,
    `- traceId: \`${c.traceId || "(none)"}\``,
    `- exit: ${c.exitCode} | run: ${c.runStatus || "?"} | aiMs: ${c.aiMs} | toolMs: ${c.toolMs} | aiSteps: ${c.aiSteps} | tokens: ${c.tokenUsage ? JSON.stringify(c.tokenUsage) : "n/a"}`,
    c.tokenAttribution ? `- estimated input attribution: ${JSON.stringify(c.tokenAttribution)}` : "",
    `- tool steps: ${c.toolSteps.length ? c.toolSteps.map((s) => `${s.name}(${s.ok ? "ok" : s.code || "fail"})`).join(" → ") : "(none)"}`,
    c.failedSteps.length ? `- failed steps: ${c.failedSteps.map((s) => `${s.name}:${s.code}`).join(", ")}` : ``,
    c.denyReasons.length ? `- gateway denies: ${c.denyReasons.join("; ")}` : ``,
    c.artifact ? `- artifact: ${c.artifact.mime} ${c.artifact.bytes} bytes` : ``,
    c.traceId ? `- drill-down: \`node scripts/ai-logs.js show ${c.traceId}\`` : ``,
  ].filter(Boolean).join("\n"));
  return [...head, ...table, ...detail].join("\n") + "\n";
}
