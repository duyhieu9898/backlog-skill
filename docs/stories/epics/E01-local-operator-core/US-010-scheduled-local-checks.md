# US-010 Scheduled Local Checks

## Status

planned

## Lane

normal

## Product Contract

After manual operator workflows are stable, the agent can run controlled local
checks on a schedule and notify the user without performing risky writes
autonomously.

## Relevant Product Docs

- `plan.md`
- `docs/stories/epics/E01-local-operator-core/README.md`

## Acceptance Criteria

- Scheduled checks are configured explicitly.
- Scheduled jobs can run read-only commands such as Bemo status checks.
- Scheduled jobs can notify Telegram with summary results.
- Scheduled jobs cannot perform external writes unless a later high-risk story
  explicitly grants that behavior.
- Schedule runs are traced like user-triggered runs.
- User can inspect last scheduled run via debug/status commands.

## Design Notes

- Commands:
  - Start with read-only checks.
- Domain rules:
  - Keep existing cron working until this story replaces a specific use case.
  - Do not build a full scheduler before manual command and trace flow is done.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Schedule config parsing and read-only policy enforcement. |
| Integration | Fake scheduled job records trace and sends fake notification. |
| E2E | Manual trigger for scheduled job path. |
| Platform | Works under systemd service runtime. |
| Release | Existing cron migration plan documented if needed. |

## Harness Delta

None expected.

## Evidence

No implementation proof yet.
