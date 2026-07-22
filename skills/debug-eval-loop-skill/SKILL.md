---
name: debug-eval-loop-skill
description: Evidence-driven agent improvement loop, run one step at a time. Run an eval, read its report/traces, make one change, re-run, then diff reports to confirm improvement. Use when optimizing agent behavior through measurement, debugging a failing or timing-out eval case, or (query.py only) inspecting production terminal-command history.
---

# Debug & Eval Loop (step-gated)

## Core principles

- **Step-gated, never auto-loops:** finish a phase → **STOP** → report (1) the result and (2) the **next step**. The caller decides whether to continue.
- **Every conclusion needs evidence** from a report or trace. Don't guess, then move on.
- **One change per iteration** (isolated variable) so REVIEW can attribute the effect correctly.
- **Default cwd: `agent/`** (the `npm run eval` script needs `package.json` here). Every command below runs from `agent/` unless noted.

## Tool map (cwd: `agent/`)

| Task | Command | Builds dist? |
|---|---|---|
| TEST (run eval) | `npm run eval -- --batch A` / `--only <id>` / `--us US-026` | yes |
| REVIEW (compare) | `node scripts/dev.js eval diff --last` | no |
| Prune reports | `node scripts/dev.js eval prune --keep 20` | no |
| Drill a raw turn | `node scripts/dev.js logs show <traceId>` | no |
| Prod command_runs | `python ../skills/debug-eval-loop-skill/scripts/query.py commands\|runs …` | no |

> Source of truth for flags: `node scripts/dev.js help` (don't memorize it — it can change).

## Phases (state machine — advance one step at a time, STOP after each)

Remember the current phase. Finish → STOP → report result + **next step**.

### TEST
```
npm run eval -- --batch A          # or: --only <id> | --us US-026 (whole story) | --batch smoke (cheap)
# filters compose: --us US-026 --batch A = US-026's provider-only cases
```
- `npm run eval` **builds dist, then runs** — REQUIRED if you just edited `src/` (eval runs `dist/cli.js`; skipping the build tests stale dist → "my change did nothing", a false conclusion).
- Report: pass/fail/⏳ per case + path to the new report.
- **STOP.** Next: any case fail/⏳ → **ANALYZE**; all pass → confirm with 1-2 more runs (see STOCHASTIC) → **pause / DONE**.

### ANALYZE
- Read the report. Map each signal to a **hypothesis** (table below). **VERIFY the hypothesis in the trace before fixing** — the table is a hint, not ground truth.
- Drill when the report is not enough: `node scripts/dev.js logs show <traceId>` (raw request/response).
- Report: likely root cause (verified) + whether it is deterministic or stochastic.
- **STOP.** Next: **IMPROVE** (exactly one change).

### IMPROVE
- Change **one** thing: `src/...` (agent behavior) OR `eval/real-trace.json` (only when `expect` is wrong on its merits; `tuning:true` is the legitimate escape hatch).
- **Never edit `expect` just to make a case pass** — it hides regressions.
- Report: what changed and why.
- **STOP.** Next: **TEST** (`npm run eval -- ...`, rebuild dist).

### REVIEW
```
node scripts/dev.js eval diff --last        # two newest reports
# or explicit when --last spans different case-sets:
node scripts/dev.js eval diff eval/reports/<old>.json eval/reports/<new>.json
```
- **Pass gate = a DETERMINISTIC signal improved** (see table) and no ✅→❌.
- `--last` assumes both reports ran the **same case-set** — mixing smoke + A/B yields only new-case/removed noise.
- **STOP.** Next:
  - improved → keep, set new baseline = current report → **TEST** (other cases) or **DONE**;
  - worse / noise → **revert**, back to **ANALYZE**;
  - ⏳ inconclusive → **do not conclude**; re-run off-peak (`EVAL_TIMEOUT_MS=120000 npm run eval -- --only <id>`), optionally `EVAL_INTER_CASE_MS=15000`.

### CLEANUP (every ~10 iterations, or when `eval/reports/` grows)
```
node scripts/dev.js eval prune --keep 20         # keep 20 newest reports for traceability
node scripts/dev.js eval prune --keep 20 --dry-run   # preview
```
- Keep enough history to trace; don't flood the dir. `logs/ai-interactions/` auto-prunes after 14 days.
- `eval/eval.sqlite` accumulates `trace_events` across runs (needed for recovery/drill-down); if it grows large, back it up then delete the file (it is recreated next run).
- For a fully pristine slate: `./scripts/my-agent clear-logs -y` (production telemetry — `agent.log`, `ai-interactions`, prod `trace_events`; keeps business data) + `node scripts/dev.js eval prune --keep 0` + `rm eval/eval.sqlite`.
- Report: cleaned.
- **STOP.** Next: resume the phase you were on.

## Diagnostic hypotheses — **VERIFY in the trace before fixing**

| Signal | Likely cause (verify) | Type |
|---|---|---|
| ⏳ `inconclusive` + `providerRetries>0` | provider 503/429 overload | deterministic → re-run |
| `routeContinuation: new`, expected `continued` | resolver didn't recognize an elliptical reference ("capture it again") | deterministic |
| `INVALID_TOOL_CALL` / `Unknown tool: X` | model called a tool outside the visible set | deterministic (visibility) |
| `pausesOrBlocks` fail | a risky action ran silently (no confirm/deny) | deterministic (gateway) |
| token spike | `toolSchemas`/`toolSteps` attribution | deterministic (see `client attribution`) |
| `artifact mime` ≠ expected | browser/screenshot path | deterministic |
| `traces=[]` | CLI crashed before `route.started` (missing dist / config / build) | deterministic → check build |
| `replyContains`/`replyMatches` fail | model answered differently than expected | ⚠️ **STOCHASTIC** — run N times |
| multi-turn case fails on a wrong-turn metric | metric taken from the wrong turn (must be the last) | deterministic → check `eval.js aggregate` |

## Deterministic vs Stochastic — important

LLM evals are **not fully deterministic**. Don't claim improvement/regression from a single run.

- **Deterministic (trust one run)** — reflects resolver/gateway/tooling, stable: `visibility.continuation`, `visibleToolNames`, `toolSchemas` (attribution), `gateway.decision` outcome, structured codes (`WEB_CAPTURED`, `INVALID_TOOL_CALL`…).
- **Stochastic (need N=2-3, or don't use as the sole gate):** `replyContains`/`replyMatches`, exact token counts, `aiSteps`, whether the model picks the right tool at each step. → re-run; trust only when ≥2/3 runs agree.

`eval diff` is most meaningful when: **same case-set** + **compare deterministic signals** + (for stochastic) **N runs already done**.

## Production debug (OUTSIDE the eval loop) — `query.py`

`query.py` is **not part of the eval loop**: the eval DB is usually **empty** for `command_runs` (eval runs go through the gateway tool executor, not `runTrackedCommand`). Use it only to debug **production**:

```
python ../skills/debug-eval-loop-skill/scripts/query.py commands 10     # recent command_runs (prod)
python ../skills/debug-eval-loop-skill/scripts/query.py runs <traceId>  # one run: exit code + output tail
```
- Defaults to the prod DB (`agent/data/agent.sqlite`). Set `AGENT_DB_FILE=eval/eval.sqlite` (relative to `agentDir`, correct from any cwd) to inspect an eval DB that has data.
- trace_events + raw AI logs: still use `dev.js eval` / `dev.js logs` (Node, correct DB, no duplication).

## Notes

- **Build:** `npm run eval` builds; `node scripts/dev.js eval` does **not** build → after editing `src/` you MUST use `npm run eval -- ...`.
- **⏳ inconclusive** = provider outage; re-run off-peak, **don't fix code**.
- **Output mangling:** stdout containing `:` (timestamps/JSON) may be re-rendered as `[file] (n):` — a known environment quirk, **not a data error**. Prefer the Read tool; if you must print structured data, use a colon-free format.
- **Tokens:** raw `logs/ai-interactions/*` redact every `/token/` key → compare tokens via `eval diff` (reports read the un-redacted `trace_events` table).
