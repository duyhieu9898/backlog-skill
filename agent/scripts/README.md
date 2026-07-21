# agent/scripts

Two entry points:

- **`dev.js`** — unified DEV/diagnostic dispatcher (Node). Route to `lib/`.
- **`my-agent`** — ops dispatcher (bash): systemd service lifecycle
  (`install`/`start`/`stop`/`restart`/`status`/`logs`/`clear-logs`/`run`/`web-smoke`).

## dev.js

```
node scripts/dev.js <command> [sub] [flags…]
```

| Command | What it does |
|---|---|
| `eval [--spec <file>] [--only <id>] [--batch smoke\|A\|B\|all]` | Run an eval spec through the real CLI (`dist/cli.js --json`) in an isolated eval DB; aggregate telemetry; write JSON+MD report to `eval/reports/`. Default spec `eval/real-trace.json`; default batch `smoke`. |
| `eval diff <old.json> <new.json>` | Diff two eval reports: pass/fail + token deltas per case. Tokens ARE meaningful here (reports read the un-redacted `trace_events` table). |
| `logs list [--limit N]` | Recent raw AI-interaction index entries (1-200, default 20). |
| `logs show <traceId> [--direction request\|response\|error]` | Print every raw record for a trace. |
| `logs diff <oldTraceId> <newTraceId>` | Diff two raw traces by provider-native fields only (tool-declaration count, image presence, turn count). |
| `smoke gemini \| telegram \| web` | One-shot transport/IO probes (need the relevant credentials in `.env`). |

### npm shortcuts (package.json)

| npm script | dispatches to |
|---|---|
| `npm run eval -- …` | `dev.js eval` (builds first) |
| `npm run eval:diff -- a.json b.json` | `dev.js eval diff` |
| `npm run ai-logs -- list \| show \| diff …` | `dev.js logs` |
| `npm run smoke:gemini` / `smoke:telegram-media` / `smoke:web` | `dev.js smoke` |

### Why token deltas live in `eval diff`, not `logs diff`

The raw AI-interaction log (`logs/ai-interactions/*`) redacts every key matching
`/token/` (privacy filter in `appendRawAiInteraction`), so `promptTokenCount`
etc. are `[redacted]` and cannot be compared across eras. `logs diff` therefore
compares only provider-native, un-redacted fields (declaration count, image
presence, turns). For token deltas, use `eval diff` — eval reports read the
un-redacted `trace_events` table.

## lib/

| Module | Exports |
|---|---|
| `bootstrap.js` | `getContext()` (lazy dist require: paths + `.env`), `loadEnv` re-export |
| `traces.js` | `findTraceFile`, `readTraceStats`, `listTraceIds`, `showTrace`, `diffTraces` |
| `reports.js` | `loadReport`, `diffReports` |
| `eval.js` | `runEval` (+ pure `renderMarkdown`, `readNormalizedUsage`, `evaluate`, `aggregate`) |
| `smoke.js` | `smokeGemini`, `smokeTelegram`, `smokeWeb` |

**Load-bearing rule:** no `lib/*` module requires `../dist/*` at module top
level — all dist requires are inside exported functions. This preserves the eval
DB invariant (`AGENT_DB_FILE` must be set before the first `dist/config/paths`
require, since `sqliteFile` resolves at module-eval time). Only `lib/eval.runEval`
touches `AGENT_DB_FILE`.
