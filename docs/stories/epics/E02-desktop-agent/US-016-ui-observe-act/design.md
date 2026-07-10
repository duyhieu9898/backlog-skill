# Design

## Domain Model

`UiSnapshot`, `UiTarget`, and `UiActionPlan` bind an action to an observed
window/application state. Plans expire when the snapshot changes.

## Application Flow

Observe → select stable target → preview exact action → confirm when needed →
act → observe again. A mismatch returns clarification rather than retrying.
The plan uses the existing digest-bound confirmation path and shared artifact
references; it does not create a UI-specific log or state store.

## Observability

Use the common desktop event envelope and store target metadata and state
digests, not screenshot bytes, in existing traces.
