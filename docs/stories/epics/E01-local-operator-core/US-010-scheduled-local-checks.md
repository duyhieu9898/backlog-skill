# US-010 Scheduled Local Checks

## Status

in_progress

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
- Implementation slice:
  - `agent/config.json` declares schedules explicitly.
  - `agent/src/scheduler.ts` validates schedule config against the allowlisted
    command catalog and refuses commands that require confirmation or declare
    `externalSideEffect`.
  - `ScheduledCheckRunner` starts enabled checks in the background service and
    sends Telegram notifications through the existing client.
  - `/schedule` lists configured checks and `/schedule run <name>` manually
    runs one check through the same traced command path.
  - `/status` includes `lastScheduledRun` from runtime state.

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

- Implemented:
  - `agent/src/scheduler.ts` loads explicit scheduled checks, validates names
    and intervals, requires read-only allowlisted commands, records
    `schedule.started`/`schedule.completed`/`schedule.failed` trace events, and
    stores `runtime_state.lastScheduledRun`.
  - `agent/src/bot.ts` starts enabled schedules after Telegram polling is
    initialized.
  - `agent/src/core/router.ts` exposes `/schedule` and
    `/schedule run <name>`.
  - `agent/config.json` includes a disabled `bemo-late` read-only schedule.
- Validation:
  - `cd agent && npm test` passed 46/46 on 2026-07-07.
  - Tests cover read-only schedule validation, risky command refusal,
    traceable scheduled command execution, `lastScheduledRun`, named lookup,
    `/schedule` listing, and `/status` output.
  - Human Telegram smoke passed on 2026-07-08 for
    `/schedule run bemo-late`. The installed service returned
    `Scheduled check success: Bemo late-day read-only check` with
    `traceId: tr_mrbefyju_94b34dd0`, exit 0, and late-day records for
    2026-07-02, 2026-07-03, 2026-07-06, and 2026-07-07.
- Remaining proof:
  - Manual Telegram smoke for `/schedule`.
  - Installed systemd runtime proof with an enabled harmless schedule.
