# US-008 Design

## Domain Model

- `LateRecord`: provider date, canonical date, check-in timestamp, late duration,
  and reason from `action-needed.json`. Native `DD/MM/YYYY` dates are preserved
  for the Bemo form while Telegram, skips, digests, and traces use
  `YYYY-MM-DD`.
- `BemoWorkflowPlan`: version, source timestamp, expiry, skipped dates,
  create dates, source digest, and selected digest.
- Dates are canonical `YYYY-MM-DD` values, unique within one plan.

Business rules:

- Every requested skip must match a current late record; typos fail closed.
- The selected set is the current records minus the exact skip set.
- A plan expires before create execution.
- Only records selected by the confirmed digest-bound plan may reach the Bemo
  create engine.

## Application Flow

```text
/bemo_late
  -> fixed read-only bemo.late-list command
  -> structured current action-needed records

natural-language create request with optional skipped dates
  -> AI selects command.bemo.prepare-timeoff with JSON args
  -> Bemo skill parses and validates skip dates
  -> Bemo skill reads current action-needed data
  -> Bemo skill returns immutable workflow plan
  -> AI selects command.bemo.create-timeoff with plan JSON
  -> preview skipped dates and selected dates
  -> confirm bemo.create-timeoff <digest>
  -> generic tool loop revalidates exact preview digest
  -> fixed argv bemo.create-timeoff command receives plan on JSON stdin
  -> Bemo wrapper validates current source + selected digest and returns structured result
```

## Interface Contract

- `/bemo_late`: list current late-day candidates as structured output.
- Natural-language create request without skip dates: preview creation for all
  current candidates.
- Natural-language create request with skip dates such as `bỏ ngày 2026-07-01`:
  exclude exact dates.
- Confirmation remains `confirm bemo.create-timeoff <12-char digest>`.
- Invalid formats, unknown dates, duplicate source dates, stale plans, digest
  mismatches, and missing plans fail without external writes.

## Data Model

- Existing SQLite pending confirmation stores the exact tool call and preview
  digest until approval.
- The plan is passed as JSON stdin to `workflows/late-timeoff.js create`; no handoff
  file and no mutation of `action-needed.json` is required.
- No database migration is required.

## UI / Platform Impact

- Telegram keeps `/bemo_late` as a direct read-only command. Create preview
  goes through the generic AI tool router rather than a Bemo-specific command
  alias.
- The installed systemd service continues using the `agent/` working directory;
  all Bemo paths resolve from repository configuration, not process cwd.

## Observability

- Trace events record selected tool, command result, and bounded output. Bemo
  command output includes source digest, skipped dates, selected dates, created
  dates, failed dates, and skipped execution dates.
- Trace payloads exclude credentials, cookies, reasons, and full attendance rows.

## Alternatives Considered

1. Rewrite `action-needed.json` before confirmation. Rejected because preview
   would mutate shared source data and races could change the approved action.
2. Pass full records through dynamic argv. Rejected because command logs would
   expose data and argv would become unnecessarily large.
3. Let the existing full-run command filter after startup. Rejected because the
   approval would not mechanically bind the skipped dates.
4. Add a Bemo-specific router branch. Rejected because skill-specific behavior
   belongs in the skill command contract, not in agent core orchestration.
