# US-008 Exec Plan

## Goal

Deliver a safe Bemo late-day vertical slice whose confirmed external write is
bound to the exact previewed dates.

## Scope

In scope:

- Structured late-list output.
- Strict skip-date parsing and filtering.
- Plan-bound preview and confirmation.
- Fixed-argv approved-plan execution.
- Unit, integration, trace, and dry-run proof.

Out of scope:

- Scheduled execution.
- AI tool selection.
- Unattended real Bemo writes.

## Risk Classification

Risk flags:

- Authorization: only the allowlisted user may approve execution.
- Audit/security: selected and created dates require trace evidence.
- External systems: confirmation may create real Bemo records.
- Existing behavior: `create-timeoff.js` gains explicit-record input.
- Weak proof: provider UI cannot run in deterministic automated tests.
- Multi-domain: agent orchestration and the Bemo skill both change.

Hard gates:

- No external write without exact-action confirmation.
- No automated test may call Bemo.
- No weakening of fixed argv, no-shell execution, or minimal environment.

## Work Phases

1. Add pure Bemo plan validation/list helpers and tests.
2. Refactor the create engine to accept explicit selected records and return a
   structured summary.
3. Add typed agent parsing, immutable confirmation context, and atomic plan
   materialization.
4. Add fixed allowlist entries and user documentation.
5. Run agent/Bemo unit and integration proof without external writes.
6. Deploy and run `/bemo_late`; require a separate explicit confirmation before
   any real create smoke.

## Stop Conditions

Pause for human confirmation if:

- Validation requires a real Bemo create rather than a dry-run fixture.
- Current action data contains duplicate or malformed dates.
- The required skip syntax must differ from the documented command contract.
- A change would broaden command authority beyond the reviewed wrapper.
