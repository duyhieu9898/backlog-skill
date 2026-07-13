# US-018 Stop Running Commands

## Status

in_progress

## Lane

normal

## Product Contract

The authorized chat user can send `/stop` to interrupt the currently executing
allowlisted command, including one started by a scheduled check or AI-routed
tool. The command runner permits only one active command globally.

## Relevant Product Docs

- `docs/product/desktop-operator.md`
- `docs/stories/epics/E01-local-operator-core/US-004-allowlisted-command-tools.md`
- `docs/stories/epics/E01-local-operator-core/US-006-debug-and-status-commands.md`

## Acceptance Criteria

- `/stop` does not wait behind the per-chat command queue.
- `/stop` requests termination of the active tracked command and identifies its trace ID.
- The stopped command is persisted as a failed run with a user-stop reason.
- `/stop` reports clearly when no command is running.
- Help documents the command.

## Design Notes

- Commands: `/stop` is a built-in Router command, not an allowlisted shell command.
- Domain rules: send `SIGTERM` first, then `SIGKILL` after five seconds if the child has not exited.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | A long-running tracked command receives `/stop`, exits with `SIGTERM`, and clears active runtime state. |
| Integration | The Router responds to `/stop` while the command is active. |
| E2E | Telegram user can stop a harmless long-running command. |
| Platform | Service process can terminate its spawned child command. |
| Release | `/help` lists `/stop`. |

## Harness Delta

None expected.

## Evidence

- `cd agent && npm test` passed on 2026-07-13: 81 tests passed, including a
  long-running Node process interrupted through the Router `/stop` path.
