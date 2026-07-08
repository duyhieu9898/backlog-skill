# US-012 Local CLI Adapter

## Status

planned

## Lane

normal

## Product Contract

The local operator can be exercised from a local command-line adapter that
routes input through the same `Router` path as Telegram. The CLI exists for
developer/operator smoke tests and direct local use; it must not bypass policy,
confirmation, trace, chat persistence, AI tool validation, or command
allowlisting.

## Relevant Product Docs

- `agent/README.md`
- `docs/stories/epics/E01-local-operator-core/README.md`
- `docs/stories/epics/E01-local-operator-core/manual-smoke-checklist.md`

## Acceptance Criteria

- A CLI entrypoint accepts one message from argv or stdin and prints the
  Router reply to stdout.
- The CLI constructs a `StandardMessage` with a stable local chat ID so pending
  confirmations can be previewed and confirmed across separate CLI invocations.
- `StandardMessage.provider` supports `cli` without weakening Telegram behavior.
- The CLI loads the same environment, config, skill registry, storage, command
  catalog, AI provider settings, and permission policy as the Telegram
  runtime.
- Direct commands such as `/status`, `/commands`, `/help`, `/last`,
  `/last-error`, `/debug <traceId>`, and `/schedule` work through the CLI.
- Command previews and `confirm <commandName> <approvalToken>` work through the
  CLI with the same digest-bound confirmation rules as Telegram.
- AI-routed requests can use the same tool loop through CLI input when provider
  credentials are configured.
- CLI runs record chat rows and trace events with provider `cli`.
- The CLI does not start Telegram polling, send Telegram messages, start the
  background scheduler, or execute any external write without the existing
  confirmation flow.

## Design Notes

- Commands:
  - Add a package script such as `npm run cli -- "<message>"`.
  - Optionally support stdin for longer prompts.
- Queries:
  - Use existing debug and schedule query paths through `Router`.
- API:
  - Reuse `Router.route(StandardMessage)`.
  - Expand `StandardMessage.provider` from `"telegram"` to `"telegram" |
    "cli"`.
- Tables:
  - Reuse existing `chat_messages`, `trace_events`, `command_runs`,
    `pending_confirmations`, `scheduled_jobs`, and `runtime_state`.
- Domain rules:
  - CLI is a transport adapter, not a privileged execution mode.
  - Confirmation state must be scoped by the stable CLI chat ID.
  - Telegram transport proof remains separate from CLI proof.
- UI surfaces:
  - stdout/stderr only.

## Validation

When updating durable proof status, use numeric booleans:
`scripts/bin/harness-cli story update --id US-012 --unit 1 --integration 1 --e2e 1 --platform 0`.

| Layer | Expected proof |
| --- | --- |
| Unit | StandardMessage provider type accepts CLI; CLI argument/stdin parsing handles empty and multi-word input. |
| Integration | CLI routes `/status`, `/commands`, denied file request, command preview, and matching confirmation through `Router` with persisted chat/trace rows. |
| E2E | Operator smoke checklist has a CLI variant that exercises the core flow without Telegram. |
| Platform | Optional installed-service proof remains Telegram-only; CLI does not need systemd proof unless installed as an operator command. |
| Release | `agent/README.md` documents CLI usage, scope, and the difference between CLI core proof and Telegram transport proof. |

## Harness Delta

Update the E01 manual smoke checklist after implementation so each step states
whether it can be proven through CLI, still requires Telegram transport, or
requires a real external provider write decision.

## Evidence

No implementation proof yet. Planned because the remaining E01 proof gaps are
mostly core operator behavior that can be exercised without a Telegram
transport round trip.
