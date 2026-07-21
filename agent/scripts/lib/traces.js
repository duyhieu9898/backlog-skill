// Raw AI-interaction trace utilities for `logs` commands. Absorbs ai-logs.js
// (list/show) and eval-diff.js trace mode (diff). Uses bootstrap.getContext() for
// the interaction dir/index. No dist require at module top level (see
// bootstrap.js).
//
// Raw logs redact every key matching /token/ (privacy filter in
// appendRawAiInteraction), so token counts are NOT extractable here — only
// provider-native, un-redacted fields (tool-declaration count, image presence,
// turn count) are compared cross-era. Token deltas live in the un-redacted
// trace_events table, surfaced via eval reports (lib/reports.js).

const fs = require("node:fs");
const path = require("node:path");

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function findTraceFile(interactionsDir, traceId) {
  // Date-scoped subdirs; traceId is unique so the first match is authoritative.
  for (const entry of fs.readdirSync(interactionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const candidate = path.join(interactionsDir, entry.name, `${traceId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Provider-native stats for a raw trace (no token fields — they are redacted). */
function readTraceStats(interactionsDir, agentDir, traceId) {
  const file = findTraceFile(interactionsDir, traceId);
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
      const decls = payload.config?.tools?.[0]?.functionDeclarations ?? payload.tools?.[0]?.functionDeclarations;
      if (Array.isArray(decls)) stats.maxDeclarations = Math.max(stats.maxDeclarations, decls.length);
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

/** `logs list`: recent index entries (newest last), like ai-logs list. */
function listTraceIds(indexFile, limit) {
  return readJsonLines(indexFile).slice(-limit).map((row) => ({
    at: row.at, traceId: row.traceId, provider: row.provider, model: row.model, direction: row.direction, bytes: row.bytes,
  }));
}

/** `logs show`: all records for a trace, optionally filtered by direction. */
function showTrace(interactionsDir, indexFile, traceId, direction) {
  const entries = readJsonLines(indexFile).filter((entry) => entry.traceId === traceId);
  const files = [...new Set(entries.map((entry) => entry.file))];
  const records = files
    .flatMap((file) => readJsonLines(path.join(interactionsDir, file)))
    .filter((record) => !direction || record.direction === direction);
  return records;
}

/** `logs diff`: markdown comparing two raw traces by provider-native fields. */
function diffTraces(interactionsDir, agentDir, oldId, newId) {
  const oldT = readTraceStats(interactionsDir, agentDir, oldId);
  const newT = readTraceStats(interactionsDir, agentDir, newId);
  if (oldT.error) throw new Error(oldT.error);
  if (newT.error) throw new Error(newT.error);

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
  return lines.join("\n") + "\n";

  function row(label, o, n) {
    const d = n - o;
    const sign = d > 0 ? "+" : "";
    lines.push(`| ${label} | ${o} | ${n} | ${sign}${d} |`);
  }
}

module.exports = { findTraceFile, readTraceStats, listTraceIds, showTrace, diffTraces };
