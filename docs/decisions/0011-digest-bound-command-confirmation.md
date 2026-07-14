# 0011 Digest-Bound Command Confirmation

Date: 2026-07-06

## Status

Superseded by [ADR 0017](0017-trusted-local-default-allow-cutover.md).

The digest remains a backend-only binding to pending action, owner/chat, run,
expiry, and action content. The user now approves a short pending ID and task
scope through Telegram buttons or CLI, not a copied digest token.

## Context

Command previews were persisted with pending confirmations, but approval used
only the command name. That did not mechanically prove that the action being
executed was the same executable, arguments, cwd, timeout, and risk state shown
to the user.

## Decision

Create a canonical command preview and hash it with SHA-256. Persist the full
digest beside the action and preview. Show its first 12 hexadecimal characters
as an approval token, and require:

```text
confirm <commandName> <approvalToken>
```

Before execution, recompute both the action preview digest and persisted preview
digest. Reject and delete the pending confirmation if either differs. A user
token mismatch does not consume the valid pending confirmation.

## Consequences

- Approval is bound to the complete command execution contract shown in the
  preview.
- Changed or corrupted pending payloads fail closed.
- Users must copy a short token in addition to the command name.
- File-tool confirmation binding remains future Router integration work.

## Verification

```bash
cd agent && npm test
```

Tests cover valid digest-bound execution, mismatched tokens, and changed pending
actions.
