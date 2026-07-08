# US-011 Schedule Management Upgrade

## Status

implemented

## Lane

high-risk

## Product Contract

The agent can manage scheduled local checks from Telegram with persistent job
state, run history, controlled delivery, and bounded autonomy, while continuing
to refuse autonomous external writes.

## Relevant Product Docs

- `agent/README.md`
- `docs/stories/epics/E01-local-operator-core/US-010-scheduled-local-checks.md`

## Acceptance Criteria

- Scheduled jobs are persisted in SQLite with enabled state, interval, delivery
  mode, next run time, and last run metadata.
- Configured schedules seed or update the durable schedule registry.
- The scheduler polls durable due jobs and does not require service restart for
  enable, disable, or interval changes.
- `/schedule`, `/schedule show <name>`, `/schedule history <name>`, and
  `/schedule run <name>` work from Telegram.
- `/schedule enable|disable <name>` and `/schedule interval <name> <minutes>`
  require confirmation before changing runtime behavior.
- Scheduled runs record durable run history and trace events.
- Delivery can be `telegram` or `silent`.
- Change-only delivery can suppress duplicate successful output.
- A schedule may create a confirmation preview for a follow-up external-effect
  command, but it must not execute that command automatically.
- No schedule can run a command that requires confirmation as its primary
  unattended check.

## Non-Goals

- No fresh agent-session jobs.
- No LLM-created schedules in this story.
- No unrestricted cron syntax; first upgrade keeps interval-based schedules.
- No autonomous Bemo time-off creation.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Schedule parsing, persistence, confirmation digest, read-only enforcement. |
| Integration | Due job execution records run history and can suppress unchanged output. |
| E2E | Telegram management commands and manual run smoke. |
| Platform | Systemd service executes a durable enabled job and delivers notification. |

## Evidence

- Implementation:
  - `agent/src/storage/db.ts` adds `scheduled_jobs` and `scheduled_runs`.
  - `agent/src/storage/repositories.ts` adds schedule job/run repositories.
  - `agent/src/scheduler.ts` seeds config into SQLite, polls durable due jobs,
    records run history, supports delivery mode, suppresses unchanged success
    notifications, and creates digest-bound follow-up previews without running
    external-effect commands.
  - `agent/src/core/router.ts` exposes `/schedule`, `/schedule show`,
    `/schedule history`, `/schedule run`, and confirmed schedule updates for
    enable, disable, interval, and delivery.
  - `agent/config.json` enables hourly `bemo-late` with Telegram change-only
    delivery and a preview-only Bemo time-off follow-up.
- Automated proof:
  - `cd agent && npm test` passed: 48 tests, 0 failures.
- Platform proof:
  - Restarted the installed `my-agent` systemd user service at 2026-07-08
    09:26:51 +07 to load the upgraded scheduler.
  - Forced durable `bemo-late.next_run_at` due in SQLite. The service tick
    picked up the row and completed trace `tr_mrbs8nto_7b3cef51`; the unchanged
    output path recorded `notification_sent=0` and advanced `next_run_at`.
  - Cleared the previous digest and forced `bemo-late` due again. The service
    completed trace `tr_mrbs9y4e_76e6d80a`, recorded `notification_sent=1`,
    advanced `next_run_at` to 2026-07-08T08:55:55.379Z, and created one pending
    digest-bound confirmation for the Bemo follow-up effect without executing
    the external write.
