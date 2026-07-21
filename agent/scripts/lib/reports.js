// Eval report diff for `eval diff`. Absorbs eval-diff.js report mode. Reads two
// JSON reports written by lib/eval.runEval and returns a markdown comparison.
// Reports come from the un-redacted trace_events table (via eval.js aggregate),
// so token deltas here ARE meaningful (unlike lib/traces.diffTraces).

const fs = require("node:fs");
const path = require("node:path");

function loadReport(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`report not found: ${resolved}`);
    err.code = "ENOENT";
    throw err;
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function diffReports(oldFile, newFile) {
  const oldR = loadReport(oldFile);
  const newR = loadReport(newFile);
  const oldCases = new Map((oldR.cases || []).map((c) => [c.id, c]));
  const newCases = new Map((newR.cases || []).map((c) => [c.id, c]));

  // Report JSON spreads summary into the root (total/passed/failed/inconclusive/
  // totalTokens...), so read those directly — there is no nested `summary` key.
  const head = (r) => `${r.passed ?? "?"}/${r.total ?? "?"} passed${r.inconclusive ? `, ${r.inconclusive} inc` : ""}, ${r.totalTokens ?? "?"} tokens`;

  const lines = [];
  lines.push(`# Eval report diff`);
  lines.push(``);
  lines.push(`old: ${path.basename(oldFile)} (${oldR.at}) — ${head(oldR)}`);
  lines.push(`new: ${path.basename(newFile)} (${newR.at}) — ${head(newR)}`);
  lines.push(``);
  lines.push("| id | pass | tokens | img-mod | aiSteps | toolSteps | note |");
  lines.push("|---|---|---:|---:|---:|---:|---|");

  const allIds = new Set([...oldCases.keys(), ...newCases.keys()]);
  let regressions = 0;
  let improvements = 0;
  for (const id of allIds) {
    const o = oldCases.get(id);
    const n = newCases.get(id);
    if (!o) { lines.push(`| ${id} | ${flag(n.pass, n.inconclusive)} | ${tok(n.tokenUsage?.total)} | ${n.tokenUsage?.imageModality ?? "-"} | ${n.aiSteps} | ${n.toolSteps.length} | new case |`); continue; }
    if (!n) { lines.push(`| ${id} | ${flag(o.pass, o.inconclusive)} | ${tok(o.tokenUsage?.total)} | - | - | - | removed |`); continue; }
    const passCell = `${flag(o.pass, o.inconclusive)}→${flag(n.pass, n.inconclusive)}`;
    const tokDelta = tokenDelta(o.tokenUsage?.total, n.tokenUsage?.total);
    const note = [];
    // inconclusive (provider outage) is neither a regression nor a fix — it is
    // "unknown". Only count real pass-state transitions.
    if (o.pass && !n.pass && !n.inconclusive) { note.push("REGRESSION"); regressions += 1; }
    if (n.pass && !o.pass && !o.inconclusive) { note.push("fixed"); improvements += 1; }
    if (n.inconclusive) note.push("provider-inconclusive");
    else if (o.inconclusive && !n.inconclusive) note.push("re-run");
    if ((n.tokenUsage?.total ?? 0) > (o.tokenUsage?.total ?? 0) && o.tokenUsage?.total != null) note.push("more tokens");
    if (o.tokenUsage?.total != null && n.tokenUsage?.total != null && n.tokenUsage.total < o.tokenUsage.total) note.push("fewer tokens");
    lines.push(`| ${id} | ${passCell} | ${tokDelta} | ${n.tokenUsage?.imageModality ?? "-"} | ${o.aiSteps}→${n.aiSteps} | ${o.toolSteps.length}→${n.toolSteps.length} | ${note.join("; ") || ""} |`);
  }

  lines.push(``);
  lines.push(`Summary: ${regressions} regression(s), ${improvements} fixed. Tokens ${oldR.totalTokens ?? "?"} → ${newR.totalTokens ?? "?"}${tokenDeltaPct(oldR.totalTokens, newR.totalTokens)}.`);
  return lines.join("\n") + "\n";
}

function flag(pass, inconclusive) { return inconclusive ? "⏳" : (pass ? "✅" : "❌"); }
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

module.exports = { loadReport, diffReports };
