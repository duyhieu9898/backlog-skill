// Eval harness for `eval`. Absorbs scripts/eval.js. runEval() is the only entry
// that may touch AGENT_DB_FILE: it sets it BEFORE the first dist require (the
// paths module resolves sqliteFile at module-eval time), then asserts the
// resolution. dev.js routes `eval` here without first calling getContext(), so
// no other dist require has run in the process.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const evalDir = path.join(__dirname, "..", "..", "eval");
const reportsDir = path.join(evalDir, "reports");
const dbFile = path.join(evalDir, "eval.sqlite");
const cliPath = path.join(__dirname, "..", "..", "dist", "cli.js");

/**
 * Run an eval spec. Sets AGENT_DB_FILE, lazy-requires dist modules, asserts the
 * DB routing, runs each case through the real CLI in an isolated DB, aggregates
 * telemetry, writes JSON+MD reports, and prints the markdown to stdout.
 * Exits 2 if no cases match the filter.
 */
function runEval({ specPath = path.join(evalDir, "real-trace.json"), onlyId, batch } = {}) {
  process.env.AGENT_DB_FILE = dbFile;
  fs.mkdirSync(reportsDir, { recursive: true });

  const { loadEnv } = require("../../dist/config/env");
  const distPaths = require("../../dist/config/paths");
  const { getDb, closeDb } = require("../../dist/storage/db");
  const { listTraceEvents, listRunSteps, getRun } = require("../../dist/storage/repositories");

  agentDir = distPaths.agentDir;
  loadEnv(path.join(agentDir, ".env"));
  if (distPaths.sqliteFile !== path.resolve(dbFile)) {
    console.error(`eval: AGENT_DB_FILE did not route sqliteFile to ${dbFile} (got ${distPaths.sqliteFile}).`);
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const allCases = Array.isArray(spec) ? spec : spec.cases;
  let cases;
  if (onlyId) {
    cases = allCases.filter((c) => c.id === onlyId);
  } else if (batch === "all") {
    cases = allCases;
  } else {
    // Default (no --batch, no --only) runs the cheap `smoke` batch so the daily
    // eval stays a fast health check. Scope proof with --batch A | B.
    const want = batch || "smoke";
    cases = allCases.filter((c) => c.batch === want);
  }
  if (cases.length === 0) {
    console.error(`eval: no cases${onlyId ? ` matching id "${onlyId}"` : ` in batch "${batch || "smoke"}"`} in ${specPath}.`);
    process.exit(2);
  }

  const env = { ...process.env, AGENT_DB_FILE: dbFile };
  const results = cases.map((c, index) => {
    const { turns } = runCase(c, index, env);
    const metrics = aggregate(turns, { listTraceEvents, listRunSteps, getRun });
    const verdict = evaluate(c, metrics);
    return { id: c.id, proof: c.proof || null, batch: c.batch || null, prompts: Array.isArray(c.prompts) ? c.prompts : [c.prompt], expect: c.expect || {}, ...metrics, ...verdict };
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
}

function runTurn(prompt, session, env, timeoutMs) {
  const startedAt = Date.now();
  let stdout = "";
  let exitCode = null;
  let timedOut = false;
  try {
    stdout = execFileSync(process.execPath, [cliPath, "--json", "--session", session, prompt], {
      cwd: agentDir,
      encoding: "utf8",
      env,
      timeout: timeoutMs || 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    exitCode = 0;
  } catch (err) {
    if (err.signal === "SIGTERM" || err.killed) timedOut = true;
    stdout = err.stdout || "";
    exitCode = err.status == null ? null : err.status;
  }
  let parsed = null;
  try { parsed = JSON.parse(stdout.split("\n").find((l) => l.startsWith("{")) || stdout); } catch { /* CLI did not emit JSON */ }
  return { traceId: parsed?.traceId || null, exitCode, timedOut, totalMs: Date.now() - startedAt, parsed };
}

let agentDir;
function runCase(c, index, env) {
  // Multi-turn cases share one session so capability lease state carries across
  // turns (continuation/clearing proofs). Each turn still gets a distinct trace.
  const session = `eval-${Date.now()}-${index}-${c.id}`;
  const prompts = Array.isArray(c.prompts) ? c.prompts : [c.prompt];
  // agentDir is set by runEval before runCase is reached; keep a local ref so
  // runTurn can read it without re-resolving.
  const turns = prompts.map((prompt) => runTurn(prompt, session, env, c.timeoutMs));
  return { turns };
}

// `ai.response.received.usage` is a NormalizedUsage object, not flat tokens.
function readNormalizedUsage(u) {
  if (!u || typeof u !== "object") return null;
  const pr = u.providerReported || {};
  const ce = u.clientEstimated || {};
  const rs = pr.rawSummary || {};
  const prompt = pr.inputTokensTotal ?? null;
  const completion = pr.outputTokens ?? null;
  // NormalizedUsage.providerReported has no flat `totalTokens`; the provider
  // total lives in the slimmed rawSummary (Gemini totalTokenCount / OpenAI
  // total_tokens).
  const total = pr.totalTokens ?? rs.totalTokenCount ?? rs.total_tokens ?? null;
  const imageModality = pr.inputByModality && typeof pr.inputByModality === "object"
    ? pr.inputByModality.IMAGE ?? pr.inputByModality.image ?? null
    : null;
  if (prompt == null && completion == null && total == null && imageModality == null) return null;
  return {
    prompt, completion, total,
    cacheRead: pr.cacheReadTokens ?? null,
    imageModality,
    observedModalities: Array.isArray(pr.observedModalities) ? pr.observedModalities : [],
    clientImageTokens: typeof ce.imageTokens === "number" ? ce.imageTokens : null,
    clientToolSchemaTokens: typeof ce.toolSchemaTokens === "number" ? ce.toolSchemaTokens : null,
    clientToolResultTokens: typeof ce.toolResultTokens === "number" ? ce.toolResultTokens : null,
  };
}

function sumUsage(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const add = (x, y) => (x == null || y == null ? (x ?? y ?? null) : x + y);
  return {
    ...a,
    prompt: add(a.prompt, b.prompt),
    completion: add(a.completion, b.completion),
    total: add(a.total, b.total),
    cacheRead: add(a.cacheRead, b.cacheRead),
    imageModality: add(a.imageModality, b.imageModality),
    clientImageTokens: add(a.clientImageTokens, b.clientImageTokens),
    clientToolSchemaTokens: add(a.clientToolSchemaTokens, b.clientToolSchemaTokens),
    clientToolResultTokens: add(a.clientToolResultTokens, b.clientToolResultTokens),
    observedModalities: Array.from(new Set([...(a.observedModalities || []), ...(b.observedModalities || [])])),
  };
}

function aggregate(turns, repo) {
  const lastTurn = turns[turns.length - 1];
  const traceIds = turns.map((t) => t.traceId).filter(Boolean);

  let aiMs = 0;
  let toolMs = 0;
  let tokens = null;
  let provider = null;
  let model = null;
  let tokenAttribution = null;
  let visibility = null;
  const denyReasons = [];
  const toolSteps = [];

  for (let i = 0; i < turns.length; i += 1) {
    const { traceId } = turns[i];
    if (!traceId) continue;
    const events = repo.listTraceEvents(traceId, 500);
    for (const row of events) {
      const p = safeParse(row.payload_json);
      if (row.event === "ai.response.received") {
        if (typeof p.latencyMs === "number") aiMs += p.latencyMs;
        const u = readNormalizedUsage(p.usage);
        if (u) tokens = sumUsage(tokens, u);
      } else if (row.event === "gateway.executed") {
        if (typeof p.latencyMs === "number") toolMs += p.latencyMs;
      } else if (row.event === "ai.request.created") {
        provider = provider || p.provider;
        model = model || p.model;
        tokenAttribution = tokenAttribution || p.tokenAttribution || null;
      } else if (row.event === "ai.tool.visibility.selected") {
        if (i === turns.length - 1) {
          visibility = {
            visibleToolNames: Array.isArray(p.visibleToolNames) ? p.visibleToolNames : [],
            schemaHash: p.schemaHash || null,
            continuation: p.continuation || null,
            capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
            selectionReason: p.selectionReason || null,
          };
        }
      } else if (row.event === "gateway.decision" && p.outcome === "deny") {
        denyReasons.push(`${p.reasonCode || "DENY"}: ${p.reason || ""}`.trim());
      }
    }
    for (const s of repo.listRunSteps(traceId)) {
      const result = safeParse(s.result_json);
      toolSteps.push({
        name: s.tool_name,
        ok: !!result.ok,
        code: result.code || null,
        data: result.data && typeof result.data === "object" ? result.data : null,
      });
    }
  }

  const run = lastTurn.traceId ? repo.getRun(lastTurn.traceId) : null;
  const failedSteps = toolSteps.filter((s) => !s.ok);
  const artifact = lastTurn.parsed?.artifact
    ? { id: lastTurn.parsed.artifact.id, mime: lastTurn.parsed.artifact.mimeType, bytes: lastTurn.parsed.artifact.byteSize, path: lastTurn.parsed.artifact.path }
    : null;

  return {
    traceIds,
    lastTraceId: lastTurn.traceId,
    exitCode: lastTurn.exitCode,
    timedOut: lastTurn.timedOut,
    runStatus: run?.status || null,
    totalMs: turns.reduce((sum, t) => sum + t.totalMs, 0),
    aiMs,
    toolMs,
    aiSteps: turns.reduce((sum, t) => sum + (t.traceId ? repo.listTraceEvents(t.traceId, 500).filter((e) => e.event === "ai.response.received").length : 0), 0),
    toolSteps,
    failedSteps,
    denyReasons,
    artifact,
    tokenUsage: tokens,
    tokenAttribution,
    visibility,
    provider,
    model,
    reply: lastTurn.parsed?.reply || null,
  };
}

function safeParse(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

function evaluate(c, m) {
  const reasons = [];
  const e = c.expect || {};
  if (e.exitCode !== undefined && m.exitCode !== e.exitCode) reasons.push(`exitCode ${m.exitCode} !== ${e.exitCode}`);
  if (e.runStatus && m.runStatus !== e.runStatus) reasons.push(`runStatus ${m.runStatus} !== ${e.runStatus}`);
  if (e.replyContains && !(m.reply || "").includes(e.replyContains)) reasons.push(`reply missing "${e.replyContains}"`);
  if (e.replyMatches && !(new RegExp(e.replyMatches).test(m.reply || ""))) reasons.push(`reply !~ /${e.replyMatches}/`);
  if (e.artifactMime && (!m.artifact || m.artifact.mime !== e.artifactMime)) reasons.push(`artifact mime ${m.artifact?.mime || "none"} !== ${e.artifactMime}`);
  if (e.maxToolSteps !== undefined && m.toolSteps.length > e.maxToolSteps) reasons.push(`toolSteps ${m.toolSteps.length} > ${e.maxToolSteps}`);
  if (m.timedOut) reasons.push("timed out");

  // US-026 capability-routing proofs.
  const names = m.visibility?.visibleToolNames || [];
  if (e.visibleToolsEmpty && names.length > 0) reasons.push(`expected no visible tools, got [${names.join(", ")}]`);
  if (e.visibleToolsNotEmpty && names.length === 0) reasons.push("expected a scoped visible-tool set, got []");
  if (e.visibleToolsMax !== undefined && names.length > e.visibleToolsMax) reasons.push(`visibleTools ${names.length} > ${e.visibleToolsMax}`);
  if (e.routeContinuation && m.visibility?.continuation !== e.routeContinuation) reasons.push(`route continuation ${m.visibility?.continuation} !== ${e.routeContinuation}`);
  if (e.toolSchemasZero && (m.tokenAttribution?.toolSchemas ?? 0) > 0) reasons.push(`toolSchemas attribution ${m.tokenAttribution?.toolSchemas} !== 0`);

  // US-027 media-modality proof.
  if (e.imageModalityNonzero) {
    const ok = (m.tokenUsage?.imageModality ?? 0) > 0;
    if (!ok) reasons.push(`expected nonzero provider image modality, got ${m.tokenUsage?.imageModality ?? "none"}`);
  }

  // US-027 browser-contract proofs (structured outcome codes).
  const codes = m.toolSteps.map((s) => s.code).filter(Boolean);
  if (Array.isArray(e.noToolCode)) {
    for (const bad of e.noToolCode) if (codes.includes(bad)) reasons.push(`forbidden tool code ${bad} appeared`);
  }
  if (Array.isArray(e.hasToolCode)) {
    if (!e.hasToolCode.some((want) => codes.includes(want))) reasons.push(`expected one of [${e.hasToolCode.join(", ")}], got [${codes.join(", ")}]`);
  }

  // US-026 #5: a risky action in an inherited task still pauses (confirmation)
  // or blocks (gateway deny) — it must never execute silently.
  if (e.pausesOrBlocks) {
    const paused = /xác nhận|approval|approve/i.test(m.reply || "");
    if (!(m.denyReasons.length > 0 || paused)) reasons.push("risky action did not pause or block");
  }

  return { pass: reasons.length === 0, reasons };
}

function renderMarkdown(r) {
  const BT = "`";
  const lines = [];
  lines.push(`# Eval ${r.at}`);
  lines.push("");
  lines.push(`provider: ${r.provider || "?"} | model: ${r.model || "?"}`);
  lines.push(`Summary: ${r.total} cases — ${r.passed} passed, ${r.failed} failed | avg ${r.avgMs}ms | ${r.totalTokens} tokens`);
  lines.push("");
  lines.push("| id | proof | pass | ms | tokens | img-mod | tools | steps | reason |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---|");
  for (const c of r.cases) {
    const tok = c.tokenUsage?.total ?? "-";
    const img = c.tokenUsage?.imageModality ?? "-";
    const ntools = (c.visibility?.visibleToolNames || []).length;
    const reason = c.reasons.join("; ") || "";
    lines.push(`| ${c.id} | ${c.proof || ""} | ${c.pass ? "✅" : "❌"} | ${c.totalMs} | ${tok} | ${img} | ${ntools} | ${c.toolSteps.length} | ${reason} |`);
  }
  for (const c of r.cases) {
    lines.push("");
    lines.push(`## ${c.id}`);
    if (c.proof) lines.push(`- proof: ${c.proof}${c.batch ? ` (batch ${c.batch})` : ""}`);
    const trace = c.traceIds.length > 1 ? c.traceIds.map((t) => BT + t + BT).join(" → ") : BT + (c.lastTraceId || "(none)") + BT;
    lines.push(`- trace: ${trace}`);
    lines.push(`- prompts: ${c.prompts.map((p) => JSON.stringify(p)).join(" → ")}`);
    const tokStr = c.tokenUsage
      ? JSON.stringify({ prompt: c.tokenUsage.prompt, completion: c.tokenUsage.completion, total: c.tokenUsage.total, imageModality: c.tokenUsage.imageModality })
      : "n/a";
    lines.push(`- exit: ${c.exitCode} | run: ${c.runStatus || "?"} | aiMs: ${c.aiMs} | toolMs: ${c.toolMs} | aiSteps: ${c.aiSteps} | tokens: ${tokStr}`);
    if (c.visibility) {
      lines.push(`- visibility: continuation=${c.visibility.continuation || "?"} tools=[${(c.visibility.visibleToolNames || []).join(", ")}] capabilities=[${(c.visibility.capabilities || []).join(", ")}]`);
    } else {
      lines.push("- visibility: (none)");
    }
    if (c.tokenAttribution) {
      lines.push(`- client attribution: toolSchemas=${c.tokenAttribution.toolSchemas ?? 0} toolSteps=${c.tokenAttribution.toolSteps ?? 0} total=${c.tokenAttribution.totalEstimated ?? "?"}`);
    }
    if (c.tokenUsage?.clientImageTokens != null) {
      lines.push(`- client image estimate: ${c.tokenUsage.clientImageTokens} tokens (never subtracted from provider total)`);
    }
    const stepsStr = c.toolSteps.length ? c.toolSteps.map((s) => s.name + "(" + (s.ok ? "ok" : s.code || "fail") + ")").join(" → ") : "(none)";
    lines.push(`- tool steps: ${stepsStr}`);
    if (c.failedSteps.length) lines.push(`- failed steps: ${c.failedSteps.map((s) => s.name + ":" + s.code).join(", ")}`);
    if (c.denyReasons.length) lines.push(`- gateway denies: ${c.denyReasons.join("; ")}`);
    if (c.artifact) lines.push(`- artifact: ${c.artifact.mime} ${c.artifact.bytes} bytes`);
    if (c.lastTraceId) lines.push(`- drill-down: ${BT}node scripts/dev.js logs show ${c.lastTraceId}${BT}`);
  }
  return lines.join("\n") + "\n";
}

module.exports = { runEval, renderMarkdown, readNormalizedUsage, evaluate, aggregate };
