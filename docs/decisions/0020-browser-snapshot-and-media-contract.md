# 0020 Browser Snapshot And Media Contract

Date: 2026-07-17

## Status

Proposed

## Context

US-027 baseline trace `tr_mropee4r_ce5853a0` exposed a browser schema that
allowed a ref action without the `snapshotId` required by runtime. Browser
refs are derived from a changing UI state and cannot safely act as stable
selectors. The succeeding screenshot-bearing trace also showed provider image
tokens absent from local text-oriented attribution.

## Decision

Make snapshot/ref ownership explicit. Canonical internal browser actions are
discriminated variants; every ref action carries matching session, tab,
snapshot, and ref identity. Runtime validates freshness and returns structured
stale/recovery state. It does not silently re-resolve an old ref for a
consequential action.

Encode provider-facing browser actions as small, strict action-specific
functions where possible; normalize any temporary flat provider envelope before
execution. Record provider-reported usage separately from client estimates by
modality and provenance. Store media durably by asset reference, hydrate replay
context selectively, and never restore browser-action authority merely by
rehydrating a historical image.

## Alternatives Considered

1. Require only `ref` and retain hidden latest-snapshot state. Rejected: schema
   and runtime diverge, causing avoidable invalid calls.
2. Automatically map stale refs to a current matching element. Rejected:
   similar UI elements can change the effect of a consequential action.
3. Use a single aggregate input-token field. Rejected: it hides image/media
   cost and falsely suggests all provider tokens are text.

## Consequences

Positive:

- Browser actions are tied to observable UI evidence.
- Recovery is deterministic and inspectable.
- Token and replay data distinguish observed provider values from estimates.

Tradeoffs:

- More schemas/state validation and richer test fixtures.
- Separate action functions can increase tool count, mitigated by US-026
  capability routing.

## Follow-Up

- Implement and validate through US-027.
- Tune snapshot TTL and media replay budgets from real provider/browser traces.
