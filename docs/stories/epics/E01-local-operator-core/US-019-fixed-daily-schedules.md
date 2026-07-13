# US-019 Fixed Daily Schedules

## Status

in_progress

## Lane

normal

## Product Contract

The Bemo late-day read-only check runs once each day at 17:00 in the configured
runtime timezone (`Asia/Ho_Chi_Minh`), rather than at a drifting interval.

## Relevant Product Docs

- `agent/README.md`
- `docs/stories/epics/E01-local-operator-core/US-010-scheduled-local-checks.md`
- `docs/stories/epics/E01-local-operator-core/US-011-schedule-management-upgrade.md`

## Acceptance Criteria

- A schedule accepts exactly one of `intervalMinutes` or 24-hour `dailyAt`.
- `dailyAt: "17:00"` computes the next 17:00 in the configured timezone.
- Restarting the service does not shift an unchanged fixed daily schedule.
- Schedule output identifies a daily fixed time rather than an interval.

## Design Notes

- `scheduled_jobs.daily_at` persists the schedule mode and allows a config
  change from interval to fixed time to reset the next due time safely.
- The runner continues polling due rows every 30 seconds; the due-row lease
  prevents duplicate execution.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Daily-time validation and timezone next-run calculation. |
| Integration | Config seed persists `daily_at` and resets the prior interval due time. |
| E2E | `/schedule show bemo-late` reports daily 17:00. |
| Platform | Restarted service preserves a next run at 17:00 Asia/Ho_Chi_Minh. |
| Release | README documents `dailyAt`. |

## Harness Delta

None expected.

## Evidence

- `cd agent && npm test` passed 82/82 on 2026-07-13, including timezone
  calculation and interval-to-daily durable reseeding coverage. (The final
  suite added one regression test and passed 83/83.)
- The installed `my-agent` service was restarted on 2026-07-13. `/schedule
  show bemo-late` reported `daily at: 17:00` and
  `next: 2026-07-13T10:00:00.000Z` (17:00 Asia/Ho_Chi_Minh).
