# US-001 Runtime State And Trace Store

## Status

in_progress

## Lane

normal

## Product Contract

The agent persists enough runtime state to explain what happened during a
Telegram request, command execution, tool call, or failure.

## Relevant Product Docs

- `plan.md`
- `agent/README.md`
- `docs/stories/epics/E01-local-operator-core/README.md`

## Acceptance Criteria

- SQLite database exists under `agent/data/agent.sqlite`.
- The agent records chat messages, trace events, command runs, pending
  confirmations, and runtime state.
- Every incoming Telegram message gets a `traceId`.
- Every command/tool action records start, completion, output tail, and errors.
- Secrets, cookies, raw `.env` values, and tokens are never stored in trace
  payloads.

## Design Notes

- Tables:
  - `chat_messages`
  - `trace_events`
  - `command_runs`
  - `pending_confirmations`
  - `runtime_state`
- Runtime state should answer current run, last run, and last error.
- Store output tails with a fixed size limit.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Trace ID generation and log redaction tests. |
| Integration | SQLite initializes and persists each table type. |
| E2E | Telegram message creates a trace and stores a chat row. |
| Platform | Service restart preserves last run/error state. |
| Release | `/status` can display DB path and current state after restart. |

## Harness Delta

Update durable proof flags after persistence tests exist.

## Evidence

- Existing implementation:
  - `agent/src/storage/db.ts` creates SQLite tables for `chat_messages`,
    `trace_events`, `command_runs`, `pending_confirmations`, and
    `runtime_state`.
  - `agent/src/storage/repositories.ts` writes chat messages, trace events,
    command runs, pending confirmations, and runtime state.
  - `agent/src/bot.ts` assigns/propagates trace IDs for Telegram messages.
  - `agent/src/commands.ts` records command start, completion, output tail, and
    error state.
- Validation:
  - `npm test` in `agent/` passed on 2026-06-26 with 10/10 tests.
- Gaps:
  - Trace/log redaction is not fully proven.
  - Telegram E2E proof is not recorded.
  - Tool calls beyond commands are not represented yet.
