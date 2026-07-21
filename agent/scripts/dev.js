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
      | B (browser) | all.
  eval diff <oldReport.json> <newReport.json>
      Diff two eval reports (pass/fail + token deltas per case).
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
      const [oldFile, newFile] = rest;
      if (!oldFile || !newFile) { process.stderr.write("eval diff needs <oldReport.json> <newReport.json>\n"); process.exit(2); }
      console.log(diffReports(oldFile, newFile));
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
