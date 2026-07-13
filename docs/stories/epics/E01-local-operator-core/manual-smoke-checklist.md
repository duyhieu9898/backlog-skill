# E01 Manual Smoke Checklist

Use this checklist when the operator can receive real Telegram messages from
the allowed user. It closes the remaining proof gaps for US-001 through US-006,
US-008, and US-009 without requiring a real external Bemo write.

## Preconditions

- The installed `my-agent` service is running and polling Telegram.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the configured AI provider
  credentials are present in the ignored runtime environment.
- Do not confirm any Bemo create preview unless the goal is a separate
  provider-write proof pass.

## Smoke Pass

Record each command, visible result, and any trace ID returned by the bot.

| Step | Action | Expected result | CLI coverage | Stories |
| --- | --- | --- | --- | --- |
| 1 | Send `/status`. | Bot reports uptime, DB path, loaded commands, loaded skills, and no unexpected current command. | Yes: `npm run cli -- "/status"`. | US-001, US-006, US-012 |
| 2 | Send `/commands`. | Bot lists reviewed allowlisted commands grouped by skill. | Yes: `npm run cli -- "/commands"`. | US-004, US-006, US-012 |
| 3 | Send `/help`. | Bot returns the available direct commands and confirmation syntax. | Yes. | US-006, US-012 |
| 4 | Send `/last`. | Bot returns the latest command result or a clear empty-state message. | Yes. | US-001, US-006, US-012 |
| 5 | Send `/last-error`. | Bot returns the latest error with trace ID or a clear empty-state message. | Yes. | US-001, US-006, US-012 |
| 6 | Send `/debug <traceId>` using a known trace ID from a prior bot response. | Bot returns formatted trace events without secrets or raw file content. | Yes, using a CLI trace ID. | US-001, US-006, US-012 |
| 7 | Ask the agent to read or edit a denied path such as `.env`. | Bot refuses clearly before any file content or mutation. | Yes when provider credentials are configured; Telegram transport proof remains separate. | US-002, US-003, US-009, US-012 |
| 8 | Trigger a harmless allowlisted command that requires confirmation. | Bot returns a preview with command, cwd, argv, timeout, and approval token; no command runs yet. | Yes. Do not confirm an external-write command for this step. | US-004, US-005, US-012 |
| 9 | Confirm the harmless command with `confirm <commandName> <approvalToken>`. | Bot executes exactly the previewed command and records the result. | Yes; use the same `local-cli` identity in a second invocation. | US-004, US-005, US-012 |
| 10 | Send `/bemo_late`. | Bot returns the read-only late-day result or a clear no-action/error state without creating time off. | Yes, subject to local Bemo availability. | US-008, US-012 |
| 11 | Ask in natural language for a Bemo late time-off preview with one skipped date if data exists. | AI routes through registered tools and returns a create preview or clear clarification; no external write occurs. | Yes when provider credentials are configured; no real write. | US-005, US-008, US-009, US-012 |
| 12 | Send `/status` again. | Bot reflects the latest command/tool state after the smoke pass. | Yes. | US-001, US-006, US-012 |

## After The Pass

- Update the relevant story evidence sections with the date, commands, trace
  IDs, and result.
- Update durable proof flags with `scripts/bin/harness-cli story update` only
  for stories whose expected proof was actually observed.
- Keep successful provider-write proof separate from this checklist. A real
  Bemo write needs explicit user approval and post-save verification evidence.
