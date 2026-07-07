# 0013 Bemo Confirmed Plan Handoff

Date: 2026-07-06

## Status

Superseded

## Context

The existing Bemo create script consumes every record in a mutable shared JSON
file. A command-only confirmation therefore cannot prove that user-skipped
dates remain excluded between preview and execution.

## Decision

- Store the filtered Bemo plan inside the digest-bound pending confirmation.
- Include a canonical digest of selected records in the command confirmation
  context while keeping executable and argv fixed.
- After valid confirmation, atomically materialize the exact plan through the
  permission-gated file tool into an ignored, short-lived file.
- Make the reviewed Bemo wrapper validate expiry, record schema, and digest,
  consume only those records, and remove the handoff file.
- Record date-only workflow trace events; never trace credentials, cookies,
  reasons, or full attendance records.

## Alternatives Considered

1. Mutate `action-needed.json` during preview. Rejected because preview must not
   change shared data and later syncs could alter the approved action.
2. Put selected records in argv. Rejected because it expands logged command data
   and weakens the fixed command contract.
3. Trust the create script to reapply skip text. Rejected because confirmation
   would not bind the exact record set.

## Consequences

Positive:

- Skipped dates are mechanically excluded from the confirmed execution input.
- Fixed argv, no-shell execution, and the central permission policy remain.
- Provider writes remain independently testable with fake records.

Tradeoffs:

- The Router owns a Bemo-specific typed workflow boundary.
- A crash may leave an expired plan file; the wrapper must reject and delete it.

## Follow-Up

- Superseded by `0014-generic-policy-gated-tool-loop.md`. The selected-record
  safety requirement remains, but Bemo-specific handoff/materialization does
  not belong in the agent core.
