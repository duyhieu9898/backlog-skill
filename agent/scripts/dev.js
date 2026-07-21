#!/usr/bin/env node
// dev — unified DEV/diagnostic dispatcher for the agent.
//
// One entry point routes to scripts/lib/*. The `eval` command sets
// AGENT_DB_FILE itself inside lib/eval.runEval before any dist require; other
// commands reach dist through lib/bootstrap.getContext() and do not touch
// AGENT_DB_FILE. See scripts/README.md for the full surface.

const { runEval } = require("./lib/eval");
const { diffReports } = require("./lib/reports");
const { listTraceIds, showTrace, diffTraces } = require("./lib/traces");
const { smokeGemini, smokeTelegram, smokeWeb } = require("./lib/smoke");

const argv = process.argv.slice(2);
const [cmd, sub, ...rest] = argv;

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(stream = process.stdout) {
  stream.write(`Usage: node scripts/dev.js <command> [sub] [flags…]

  eval [--spec <file>] [--only <id>] [--batch smoke|A|B|all]
      Run an eval spec against the real CLI. Default spec eval/real-trace.json;
      default batch "smoke" (cheap daily). Proof runs: --batch A (provider-only)
      | B (browser) | all. Provider-resilience env: EVAL_INTER_CASE_MS (cool-down
      between cases; default 10000 for A/B, 0 for smoke) and EVAL_TIMEOUT_MS
      (per-turn override — raise during a Gemini 503/429 spike). A case where
      every turn dies on provider retries is marked ⏳ inconclusive, not failed.
  eval diff <oldReport.json> <newReport.json> | --last
      Diff two eval reports (pass/fail + token deltas per case). --last auto-picks
      the two newest reports in eval/reports/ (frictionless review step). NOTE:
      --last assumes both reports ran the same case set — mixing smoke + A/B
      yields only new-case/removed noise.
  eval prune [--keep N] [--dry-run]
      Delete eval reports beyond the N newest (default 20; each run = .json + .md).
      Keeps eval/reports/ traceable over many loop iterations. --dry-run previews.
  logs list [--limit N]
      Recent raw AI-interaction index entries (N: 1-200, default 20).
  logs show <traceId> [--direction request|response|error]
      Print every raw record for a trace.
  logs diff <oldTraceId> <newTraceId>
      Diff two raw traces by provider-native fields only (declarations, image,
      turns). Token counts are redacted in raw logs — use "eval diff" for tokens.
  smoke gemini | telegram | web
      One-shot transport/IO probes (need the relevant credentials in .env).
  help | --help
      Show this help.
`);
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    usage();
    return;
  }

  if (cmd === "eval") {
    if (sub === "diff") {
      let oldFile, newFile;
      if (rest.includes("--last")) {
        const fs = require("node:fs");
        const path = require("node:path");
        const { reportsDir } = require("./lib/bootstrap").getContext();
        // Report filenames are ISO timestamps → lexicographic sort == chronological.
        const jsons = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".json")).sort();
        if (jsons.length < 2) { process.stderr.write(`eval diff --last needs >=2 reports in ${reportsDir}\n`); process.exit(2); }
        oldFile = path.join(reportsDir, jsons[jsons.length - 2]);
        newFile = path.join(reportsDir, jsons[jsons.length - 1]);
      } else {
        [oldFile, newFile] = rest;
        if (!oldFile || !newFile) { process.stderr.write("eval diff needs <oldReport.json> <newReport.json> (or --last)\n"); process.exit(2); }
      }
      console.log(diffReports(oldFile, newFile));
      return;
    }
    if (sub === "prune") {
      // Reports accumulate unbounded over many loop iterations; keep the N newest
      // (each run writes <stem>.json + <stem>.md). Keeps history traceable without
      // drowning the dir. `--dry-run` lists what would be removed.
      const fs = require("node:fs");
      const path = require("node:path");
      const { reportsDir } = require("./lib/bootstrap").getContext();
      const keepIdx = rest.indexOf("--keep");
      const keep = keepIdx >= 0 ? Number(rest[keepIdx + 1]) : 20;
      if (!Number.isFinite(keep) || keep < 0) { process.stderr.write("eval prune --keep must be a non-negative number\n"); process.exit(2); }
      const stems = [...new Set(fs.readdirSync(reportsDir)
        .filter((f) => f.endsWith(".json") || f.endsWith(".md"))
        .map((f) => f.replace(/\.(json|md)$/, "")))]
        .sort(); // ISO timestamp stems → asc == chronological
      const remove = stems.slice(0, Math.max(0, stems.length - keep));
      if (rest.includes("--dry-run")) {
        console.log(`eval prune (dry-run): would keep ${stems.length - remove.length}/${stems.length}, remove ${remove.length}: ${remove.join(", ") || "(none)"}`);
        return;
      }
      let n = 0;
      for (const stem of remove) {
        for (const ext of [".json", ".md"]) {
          const p = path.join(reportsDir, stem + ext);
          if (fs.existsSync(p)) { fs.unlinkSync(p); n += 1; }
        }
      }
      console.log(`eval prune: kept ${stems.length - remove.length}/${stems.length} reports, removed ${n} files in ${path.relative(process.cwd(), reportsDir) || reportsDir}`);
      return;
    }
    // runEval sets AGENT_DB_FILE before any dist require — call it directly.
    runEval({
      specPath: flag([sub, ...rest], "--spec"),
      onlyId: flag([sub, ...rest], "--only"),
      batch: flag([sub, ...rest], "--batch"),
    });
    return;
  }

  if (cmd === "logs") {
    const { aiInteractionDir, aiInteractionIndex } = require("./lib/bootstrap").getContext();
    if (sub === "list") {
      const limit = Number(flag(rest, "--limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) { process.stderr.write("logs list --limit must be 1-200\n"); process.exit(2); }
      for (const row of listTraceIds(aiInteractionIndex, limit)) console.log(JSON.stringify(row));
      return;
    }
    if (sub === "show") {
      const traceId = rest[0];
      if (!traceId) { process.stderr.write("logs show needs <traceId>\n"); process.exit(2); }
      const direction = flag(rest, "--direction");
      if (direction && !["request", "response", "error"].includes(direction)) { process.stderr.write("logs show --direction must be request|response|error\n"); process.exit(2); }
      for (const record of showTrace(aiInteractionDir, aiInteractionIndex, traceId, direction)) console.log(JSON.stringify(record));
      return;
    }
    if (sub === "diff") {
      const [oldId, newId] = rest;
      if (!oldId || !newId) { process.stderr.write("logs diff needs <oldTraceId> <newTraceId>\n"); process.exit(2); }
      console.log(diffTraces(aiInteractionDir, require("./lib/bootstrap").getContext().agentDir, oldId, newId));
      return;
    }
    process.stderr.write(`Unknown logs subcommand: ${sub ?? "(none)"}\n`);
    process.exit(2);
  }

  if (cmd === "smoke") {
    try {
      if (sub === "gemini") { await smokeGemini(); return; }
      if (sub === "telegram") { await smokeTelegram(); return; }
      if (sub === "web") { await smokeWeb(); return; }
      process.stderr.write(`smoke needs gemini | telegram | web (got ${sub ?? "(none)"})\n`);
      process.exit(2);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  process.stderr.write(`Unknown command: ${cmd}\n`);
  usage(process.stderr);
  process.exit(2);
}

main();
