# US-005 Preview And Confirmation Flow

## Status

in_progress

## Lane

high-risk

## Product Contract

Before the agent performs a risky action, it shows a concise preview and waits
for explicit user confirmation.

## Relevant Product Docs

- `plan.md`
- `docs/stories/epics/E01-local-operator-core/README.md`
- `docs/stories/epics/E01-local-operator-core/US-001-runtime-state-and-trace-store.md`

## Acceptance Criteria

- Pending confirmations are persisted in SQLite with `chatId`, `traceId`,
  action type, payload, expiry, and status.
- Confirmation expires after a configured interval.
- A new command cancels the old pending confirmation for the chat.
- User confirms with `confirm <commandName> <approvalToken>`, where the token
  is derived from the exact preview.
- Expired or mismatched confirmations are rejected.
- Preview includes what will change, what will be skipped, and what command/tool
  will run.

## Design Notes

- Tables:
  - `pending_confirmations`
- Domain rules:
  - External-service writes always require confirmation.
  - File writes can be auto-approved only for low-risk configured paths.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Confirmation creation, matching, expiry, cancellation. |
| Integration | Pending confirmation survives process restart. |
| E2E | Telegram user previews and confirms a fake command. |
| Platform | Clock handling is stable under service runtime. |
| Release | Risky Bemo create action cannot run without confirmation. |

## Harness Delta

High-risk because it protects external effects and destructive local changes.

## Evidence

- Existing implementation:
  - `agent/src/core/router.ts` creates pending confirmations for commands whose
    `requiresConfirmation` flag is true.
  - `agent/src/storage/repositories.ts` persists pending confirmations by chat
    ID and supports replacement/cancellation.
  - `confirm <commandName> <approvalToken>` consumes a pending confirmation
    only after its exact action and preview digest are recomputed and matched.
- Validation:
  - `npm test` in `agent/` passed 25/25 on 2026-07-06 with tests for command
    confirmation expiry/replacement, exact digest success, mismatched token
    refusal, changed-action refusal, and file mutation previews/refusal.
- File-tool foundation:
  - US-003 returns structured mkdir/write/patch previews and requires a trusted
    `confirmationGranted` context before mutation.
  - US-002 now centralizes risk decisions in `PermissionPolicy`.
- Exact-action binding:
  - Command confirmations are bound to a SHA-256 digest covering command name,
    label, executable, args, cwd, timeout, and risk flags. Telegram uses the
    first 12 hex characters as the explicit approval token.
- Gaps:
  - File previews are internal and are not yet persisted or shown by Router.
  - Bemo skipped dates and structured external action previews remain pending.
