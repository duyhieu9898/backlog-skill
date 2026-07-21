#!/usr/bin/env node
// eval-diff — compare two eval reports, or two raw AI-interaction traces.
//
// Two modes:
//   report <old.json> <new.json>   diff two eval reports produced by eval.js.
//                                  Stable: both come from the same eval.js, so
//                                  the schema matches across runs. This is the
//                                  workhorse for "did this change regress or
//                                  cost more tokens?".
//   trace  <oldId> <newId>         diff two raw traces (logs/ai-interactions).
//                                  NARROW by design: it extracts ONLY provider-
//                                  native fields (Gemini usageMetadata tokens,
//                                  request functionDeclarations count, inline
//                                  image presence). Those fields come from the
//                                  provider, not our logging, so they stay
//                                  comparable across eras (e.g. a 2026-07-17
//                                  baseline vs today). Our internal event schema
//                                  (NormalizedUsage, visibility, attribution) is
//                                  deliberately NOT compared cross-era — it has
//                                  evolved and would give misleading deltas.
//
// Usage:
//   node scripts/eval-diff.js report eval/reports/<old>.json eval/reports/<new>.json
//   node scripts/eval-diff.js trace  tr_mropch57_2b339e0a  tr_<new>

const fs = require("node:fs");
const path = require("node:path");

const agentDir = path.resolve(__dirname, "..");
const interactionsDir = path.join(agentDir, "logs", "ai-interactions");

const [, , mode, a, b] = process.argv;
if (!mode || !a || !b) {
  console.error("Usage: eval-diff.js report <old.json> <new.json> | trace <oldId> <newId>");
  process.exit(2);
}

if (mode === "report") diffReport(a, b);
else if (mode === "trace") diffTrace(a, b);
else {
  console.error(`Unknown mode "${mode}". Use report or trace.`);
  process.exit(2);
}

// --- report diff -----------------------------------------------------------

function readJson(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`report not found: ${resolved}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function diffReport(oldFile, newFile) {
  const oldR = readJson(oldFile);
  const newR = readJson(newFile);
  const oldCases = new Map((oldR.cases || []).map((c) => [c.id, c]));
  const newCases = new Map((newR.cases || []).map((c) => [c.id, c]));

  const lines = [];
  lines.push(`# Eval report diff`);
  lines.push(``);
  lines.push(`old: ${path.basename(oldFile)} (${oldR.at}) — ${(oldR.summary || {}).passed ?? "?"}/${(oldR.summary || {}).total ?? "?"} passed, ${oldR.summary?.totalTokens ?? "?"} tokens`);
  lines.push(`new: ${path.basename(newFile)} (${newR.at}) — ${(newR.summary || {}).passed ?? "?"}/${(newR.summary || {}).total ?? "?"} passed, ${newR.summary?.totalTokens ?? "?"} tokens`);
  lines.push(``);
  lines.push("| id | pass | tokens | img-mod | aiSteps | toolSteps | note |");
  lines.push("|---|---|---:|---:|---:|---:|---|");

  const allIds = new Set([...oldCases.keys(), ...newCases.keys()]);
  let regressions = 0;
  let improvements = 0;
  for (const id of allIds) {
    const o = oldCases.get(id);
    const n = newCases.get(id);
    if (!o) { lines.push(`| ${id} | ${flag(n.pass)} | ${tok(n.tokenUsage?.total)} | ${n.tokenUsage?.imageModality ?? "-"} | ${n.aiSteps} | ${n.toolSteps.length} | new case |`); continue; }
    if (!n) { lines.push(`| ${id} | ${flag(o.pass)} | ${tok(o.tokenUsage?.total)} | - | - | - | removed |`); continue; }
    const passCell = `${flag(o.pass)}→${flag(n.pass)}`;
    const tokDelta = tokenDelta(o.tokenUsage?.total, n.tokenUsage?.total);
    const note = [];
    if (o.pass && !n.pass) { note.push("REGRESSION"); regressions += 1; }
    if (!o.pass && n.pass) { note.push("fixed"); improvements += 1; }
    if ((n.tokenUsage?.total ?? 0) > (o.tokenUsage?.total ?? 0) && o.tokenUsage?.total != null) note.push("more tokens");
    if (o.tokenUsage?.total != null && n.tokenUsage?.total != null && n.tokenUsage.total < o.tokenUsage.total) note.push("fewer tokens");
    lines.push(`| ${id} | ${passCell} | ${tokDelta} | ${n.tokenUsage?.imageModality ?? "-"} | ${o.aiSteps}→${n.aiSteps} | ${o.toolSteps.length}→${n.toolSteps.length} | ${note.join("; ") || ""} |`);
  }

  lines.push(``);
  lines.push(`Summary: ${regressions} regression(s), ${improvements} fixed. Tokens ${oldR.summary?.totalTokens ?? "?"} → ${newR.summary?.totalTokens ?? "?"}${tokenDeltaPct(oldR.summary?.totalTokens, newR.summary?.totalTokens)}.`);
  console.log(lines.join("\n") + "\n");
}

// --- trace diff (provider-native fields only) ------------------------------

function findTraceFile(traceId) {
  // Date-scoped subdirs; traceId is unique so the first match is authoritative.
  for (const entry of fs.readdirSync(interactionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const candidate = path.join(interactionsDir, entry.name, `${traceId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readTrace(traceId) {
  const file = findTraceFile(traceId);
  if (!file) return { error: `trace not found: ${traceId}` };
  const stats = { traceId, file: path.relative(agentDir, file), requests: 0, responses: 0, maxDeclarations: 0, imagePresent: false };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const payload = rec.payload;
    if (!payload || typeof payload !== "object") continue;
    if (rec.direction === "request") {
      stats.requests += 1;
      // Gemini nests tools under config.tools[0].functionDeclarations. This is a
      // count, not a token field, so it survives the raw-log redaction filter.
      const decls = payload.config?.tools?.[0]?.functionDeclarations ?? payload.tools?.[0]?.functionDeclarations;
      if (Array.isArray(decls)) stats.maxDeclarations = Math.max(stats.maxDeclarations, decls.length);
      // inlineData is redacted to { mimeType, data: "[redacted ...]" } but the
      // key remains, so presence is still detectable.
      try {
        for (const content of payload.contents || []) {
          for (const part of content.parts || []) {
            if (part.inlineData) stats.imagePresent = true;
          }
        }
      } catch { /* malformed/foreign shape — skip */ }
    } else if (rec.direction === "response") {
      stats.responses += 1;
    }
  }
  return stats;
}

function diffTrace(oldId, newId) {
  const oldT = readTrace(oldId);
  const newT = readTrace(newId);
  if (oldT.error) { console.error(oldT.error); process.exit(1); }
  if (newT.error) { console.error(newT.error); process.exit(1); }

  const lines = [];
  lines.push(`# Trace diff (raw log: declarations / image / turns only)`);
  lines.push(``);
  lines.push(`old: ${oldId} — ${oldT.file}`);
  lines.push(`new: ${newId} — ${newT.file}`);
  lines.push(``);
  lines.push("| metric | old | new | delta |");
  lines.push("|---|---:|---:|---:|");
  row("tool declarations (max)", oldT.maxDeclarations, newT.maxDeclarations);
  row("AI turns (requests)", oldT.requests, newT.requests);
  row("provider responses", oldT.responses, newT.responses);
  lines.push(`| image present | ${oldT.imagePresent} | ${newT.imagePresent} | ${oldT.imagePresent === newT.imagePresent ? "same" : "changed"} |`);
  lines.push(``);
  lines.push(`> Token counts are NOT compared here: the raw AI-interaction log redacts every key matching /token/ (privacy filter in appendRawAiInteraction), so promptTokenCount etc. are "[redacted]". Use \`report\` mode (eval reports read the un-redacted trace_events table) for token deltas.`);
  console.log(lines.join("\n") + "\n");

  function row(label, o, n) {
    const d = n - o;
    const sign = d > 0 ? "+" : "";
    lines.push(`| ${label} | ${o} | ${n} | ${sign}${d} |`);
  }
}

// --- helpers ---------------------------------------------------------------

function flag(pass) { return pass ? "✅" : "❌"; }
function tok(n) { return n == null ? "-" : String(n); }
function tokenDelta(o, n) {
  if (o == null && n == null) return "-";
  if (o == null) return `${n} (new)`;
  if (n == null) return `${o} → ?`;
  return `${o}→${n}`;
}
function tokenDeltaPct(o, n) {
  if (!o) return "";
  const pct = (((n - o) / o) * 100).toFixed(1);
  return ` (${pct > 0 ? "+" : ""}${pct}%)`;
}
