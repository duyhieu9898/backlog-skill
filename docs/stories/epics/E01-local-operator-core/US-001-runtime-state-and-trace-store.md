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
  - `agent/src/core/router.ts` persists inbound user messages and outbound
    assistant replies through `insertChatMessage`.
  - `agent/src/commands.ts` records command start, completion, output tail, and
    error state.
- Validation:
  - `scripts/bin/harness-cli story verify-all` passed all configured story
    verification commands on 2026-07-07.
  - `cd agent && npm test` passed 42/42 on 2026-07-07.
- Gaps:
  - Chat persistence is wired in `Router`, but direct tests/assertions for
    stored user/assistant chat rows are still missing.
  - Trace/log redaction is implemented for sensitive payload keys, but direct
    redaction tests are still missing.
  - Telegram E2E proof for trace/chat persistence is not recorded.
