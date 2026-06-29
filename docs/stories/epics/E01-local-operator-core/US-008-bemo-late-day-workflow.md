# US-008 Bemo Late-Day Workflow

## Status

planned

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
  - `bemo.create-timeoff` or equivalent existing script command.
- Domain rules:
  - Prefer structured JSON output from Bemo scripts.
  - If Bemo scripts currently output text only, add a normalizer before the AI
    uses the data.

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

No implementation proof yet.
