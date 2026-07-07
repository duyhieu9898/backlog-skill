# 0014 Generic Policy-Gated Tool Loop

Date: 2026-07-07

## Status

Accepted

## Context

The Bemo late-day workflow needs the agent to compose a read-only plan step
with a confirmed create step. A Bemo-specific router branch could satisfy that
single workflow, but it would put skill behavior into core orchestration and
make every new skill a reason to edit the router.

## Decision

- Keep `agent/src/core/router.ts` generic.
- Expose reviewed file tools and allowlisted commands as typed AI tools.
- Let commands declare JSON-stdin input schemas for structured skill-specific
  behavior.
- Validate provider output as exactly one of `text`, `clarification`, or
  `toolCall`.
- Execute at most four non-confirmed tool steps per user request.
- Pause at the first confirmed side effect and store the exact tool call plus
  preview digest.
- After confirmation, execute exactly the approved tool call and do not
  automatically continue planning.

## Alternatives Considered

1. Keep a Bemo-specific router workflow. Rejected because skill-specific
   behavior would leak into core logic.
2. Let the model call raw shell commands. Rejected because it bypasses reviewed
   command allowlists and permission policy.
3. Rewrite Bemo source data before create. Rejected because preview should not
   mutate shared provider-derived state.

## Consequences

Positive:

- New skills can add structured behavior by registering commands and schemas.
- Core authority remains concentrated in the permission policy, command
  allowlist, file tools, and confirmation store.
- Bemo can skip dates without mutating `action-needed.json` or adding router
  special cases.

Tradeoffs:

- Provider prompting and schema quality now affect whether natural-language
  requests compose successfully.
- Complex workflows need skill commands that return machine-readable outputs.

## Follow-Up

- Complete Telegram/provider smoke for Bemo natural-language preview.
- Consider richer result schemas if future skills need machine-checked output
  beyond command stdout.
