# E02 Desktop Agent

## Goal

Extend the local operator with safe desktop observation and control: capture a
screen, deliver it to Telegram, launch reviewed apps, and later perform bounded
UI workflows with visible recovery behavior.

## Scope Boundary

The agent does not gain raw shell or unrestricted remote desktop access. Each
platform capability is declared, policy-gated, observable, and independently
testable.

## Shared Contracts

US-013 owns the contracts below. Later stories must extend them rather than
create parallel policy, logging, state, confirmation, or delivery paths.

| Concern | Shared owner and rule |
| --- | --- |
| Authority | `PermissionPolicy` remains the only allow/confirm/deny boundary for typed desktop actions. |
| Confirmation | Reuse the existing digest-bound `pending_confirmations` flow; do not add a desktop-specific approval store. |
| Trace | Every action reuses the request `traceId` and emits existing `trace_events` with a common desktop event envelope. |
| Raw provider logs | Continue the independent `ai-interactions` JSONL store only for provider wire payloads; desktop stories must not duplicate it. |
| Artifacts | Artifact bytes live in the local artifact store; SQLite retains only metadata, expiry, owner chat, source trace, and delivery state. |
| Delivery | A reusable presenter/channel response envelope owns text-plus-artifact delivery; tools never call Telegram directly. |
| Workflow state | Durable workflow metadata belongs in the existing SQLite/repository migration path, not a second JSON state file. |

### Desktop Event Envelope

Desktop trace events use `{ component: "desktop", action, outcome, artifactId?,
workflowId?, reasonCode? }`. Raw screenshots, paths, and bytes are excluded.

## Initial Platform Scope

The first implementation targets the current Linux desktop host through one
reviewed adapter. macOS and Windows adapters share the contracts but are not
part of US-013 through US-015 acceptance proof.

## Recommended Order

| Story | Outcome | Depends On |
| --- | --- | --- |
| US-013 | Typed desktop capability and permission contract | E01 policy/confirmation |
| US-014 | Temporary media artifact store and Telegram delivery | US-013 |
| US-015 | Promptable screenshot-send and reviewed app launch vertical slice | US-013, US-014 |
| US-016 | UI observation and bounded click/type actions | US-015 |
| US-017 | Workflow state, recovery, and prompt-trial evidence loop | US-016 |

## Prompt Trial Loop

After US-015, run human Telegram prompts for screenshot delivery and app
launch. Use `npm run ai-logs -- list` to find a trace, then inspect only the
needed `request`, `response`, or `error` record. Turn each observed failure
into a bounded follow-up story rather than widening raw desktop authority.
