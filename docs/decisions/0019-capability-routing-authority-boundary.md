# 0019 Capability Routing And Authority Boundary

Date: 2026-07-17

## Status

Accepted

## Context

US-026 found that an unscoped general-chat request exposed all 18 native tool
schemas. A later desktop continuation without an explicit app name also fell
back to the full catalog. Reducing schema exposure needs context-aware routing,
but a routing model can be wrong and must never become an authority mechanism.

## Decision

Represent request intent as a `CapabilityRoute` with capabilities, resource
targets, continuation state, confidence, and sanitized reason. Resolve it in
three stages: deterministic hard signals, bounded active-scope lease, then a
small constrained route model only for ambiguity.

Use a reviewed static capability-to-tool map as the initial source of visible
tools. Apply provider support, availability, and current authority policy to
produce an exact run-level visible-tool snapshot before provider encoding.
General and low-confidence routes expose no tools. Scope continuation carries
task context only; write, execute, and other dangerous authority is never
inherited. Every call still passes schema validation, current policy, and
approval through `ToolGateway` when executed.

## Alternatives Considered

1. Let one LLM router choose schemas and authorize calls. Rejected because a
   misclassification could become an authority escalation.
2. Use the full catalog whenever routing is uncertain. Rejected because it
   recreates the measured schema cost and increases accidental tool selection.
3. Add provider-native Tool Search now. Rejected because the present catalog is
   small; a static bounded map is simpler and provider-neutral.

## Consequences

Positive:

- General chat has zero tool-schema cost.
- Follow-ups retain relevant task state without leaking tools into topic changes.
- The model's visible tools and server authority remain auditable separately.

Tradeoffs:

- Adds route/lease state and deterministic regression fixtures.
- Some ambiguous requests receive clarification or no tools rather than an
  opportunistic full-catalog attempt.

## Follow-Up

- Implement and validate through US-026.
- Revisit provider-native deferred Tool Search only when the catalog materially
  exceeds the direct-tool budget.
