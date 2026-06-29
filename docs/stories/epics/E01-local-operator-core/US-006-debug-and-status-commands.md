# US-006 Debug And Status Commands

## Status

in_progress

## Lane

normal

## Product Contract

The user can inspect what the local operator is doing and what happened most
recently without reading logs manually.

## Relevant Product Docs

- `agent/README.md`
- `plan.md`
- `docs/stories/epics/E01-local-operator-core/README.md`

## Acceptance Criteria

- `/status` shows uptime, current command, pending confirmation state, loaded
  command count, loaded skill count, and SQLite DB path.
- `/last` shows latest command result and output tail.
- `/last-error` shows latest failed command or tool error with trace ID.
- `/debug <traceId>` returns raw or lightly formatted trace events.
- `/commands` lists allowlisted commands grouped by skill.
- `/skills` lists scanned skills and descriptions.

## Design Notes

- Commands:
  - Built-in router commands, no AI required.
- Queries:
  - Read from SQLite runtime and trace tables.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Command parsing and formatting. |
| Integration | Debug commands read seeded SQLite state. |
| E2E | Telegram smoke test for each command. |
| Platform | Service status command still works after restart. |
| Release | README lists available debug commands. |

## Harness Delta

None expected.

## Evidence

- Existing implementation:
  - `agent/src/core/debugCommands.ts` implements `/status`, `/last`,
    `/last-error`, `/debug <traceId>`, `/commands`, `/skills`, `/help`, and
    `help`.
  - Debug commands read runtime state, command runs, trace events, command
    catalog, and skill registry metadata.
- Validation:
  - `npm test` in `agent/` passed on 2026-06-26 with persistence and command
    catalog coverage.
- Gaps:
  - Telegram manual smoke proof is not recorded.
  - `/status` does not yet include loaded skill count or registry errors.
  - README does not fully document the debug commands.
