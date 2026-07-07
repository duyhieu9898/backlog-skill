# US-008 Bemo Late-Day Workflow

## Status

in_progress

## Lane

high-risk

## Product Contract

The agent can help with the Bemo late-day workflow end to end: get late-day
data, skip user-specified dates, preview remaining actions, ask for
confirmation, and create only the confirmed items.

## Relevant Product Docs

- `skills/bemo/SKILL.md`
- `plan.md`
- `docs/stories/epics/E01-local-operator-core/README.md`

## Acceptance Criteria

- Bemo late-list command is allowlisted.
- Bemo create command is allowlisted and requires confirmation.
- Late-day results are available as structured data or normalized by the agent.
- User can specify dates to skip.
- Preview clearly lists skipped dates and dates that will be created.
- Confirmed create command cannot create skipped dates.
- Trace records input, selected skill, skipped dates, created dates, command
  result, and errors.
- No Bemo external write occurs without explicit confirmation.

## Design Notes

- Commands:
  - `bemo.late-list`
  - `bemo.prepare-timeoff`
  - `bemo.create-timeoff`
- Domain rules:
  - The Bemo skill owns date normalization, skip validation, plan construction,
    and create execution.
  - The agent core only runs generic registered tools and confirmation flow; it
    has no Bemo-specific router branch.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Date parsing, skip filtering, preview generation. |
| Integration | Fake Bemo command output filters correctly and calls fake create only for remaining dates. |
| E2E | Telegram smoke test with dry-run Bemo data. |
| Platform | Real Bemo command stays behind confirmation. |
| Release | Manual proof with dry-run or test account before real write. |

## Harness Delta

High-risk because it can write to an external Bemo service.

## Evidence

- Implemented foundation:
  - `agent/src/tools/loop.ts` and `agent/src/tools/executor.ts` expose generic,
    policy-gated file and allowlisted-command tools to the AI with bounded tool
    steps and exact confirmation.
  - `agent/commands.json` allowlists read-only `bemo.late-list`, structured
    `bemo.prepare-timeoff`, and confirmed `bemo.create-timeoff` fixed-argv
    commands.
  - `skills/bemo/src/workflows/late-timeoff.js` lists structured records, validates
    version/expiry/source digest/selected digest/skips, calls the create engine
    with only approved records, and returns structured results.
  - `create-timeoff.js` accepts explicit approved records while preserving the
    legacy action-file entry point.
- Validation:
  - Agent suite passes 42/42, including structured AI outcome validation,
    JSON-stdin command input, unknown-tool rejection, bounded composition, and
    pause-before-confirmed-effect behavior.
  - Bemo suite passes 6/6 with a fake create callback and no browser/provider
    access.
  - Read-only local smoke parsed the current ignored `action-needed.json`:
    count=1, createDates=1, skippedDates=0; no provider write executed.
  - Installed `my-agent` service restarted, rebuilt TypeScript, launched
    `node dist/bot.js`, and entered Telegram polling.
- Remaining proof:
  - Complete human Telegram `/bemo_late` plus natural-language create preview
    smoke through the AI tool router.
    without confirming a real write.
  - A real provider write requires a separate explicit user decision.
