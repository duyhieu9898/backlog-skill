#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const agentDir = path.resolve(__dirname, "..");
const storeDir = path.join(agentDir, "logs", "ai-interactions");
const indexFile = path.join(storeDir, "index.jsonl");

function usage() {
  console.error("Usage: npm run ai-logs -- list [--limit N] | show <traceId> [--direction request|response|error]");
  process.exit(1);
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function list(args) {
  const limitFlag = args.indexOf("--limit");
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) usage();
  const rows = readJsonLines(indexFile).slice(-limit);
  for (const row of rows) {
    console.log(JSON.stringify({
      at: row.at,
      traceId: row.traceId,
      provider: row.provider,
      model: row.model,
      direction: row.direction,
      bytes: row.bytes,
    }));
  }
}

function show(args) {
  const traceId = args[0];
  if (!traceId) usage();
  const directionFlag = args.indexOf("--direction");
  const direction = directionFlag >= 0 ? args[directionFlag + 1] : undefined;
  if (direction && !["request", "response", "error"].includes(direction)) usage();

  const entries = readJsonLines(indexFile).filter((entry) => entry.traceId === traceId);
  const files = [...new Set(entries.map((entry) => entry.file))];
  const records = files
    .flatMap((file) => readJsonLines(path.join(storeDir, file)))
    .filter((record) => !direction || record.direction === direction);
  for (const record of records) console.log(JSON.stringify(record));
}

const [command, ...args] = process.argv.slice(2);
if (command === "list") list(args);
else if (command === "show") show(args);
else usage();
