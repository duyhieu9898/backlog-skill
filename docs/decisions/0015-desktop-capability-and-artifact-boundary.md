# 0015 Desktop Capability And Artifact Boundary

Date: 2026-07-10

## Status

Accepted

## Context

Desktop screenshots and app launching make the agent materially more useful,
but introduce OS permissions, private screen data, media transport, and remote
execution risk.

## Decision

Implement desktop control as typed capability adapters behind the existing
permission and confirmation boundaries. Persist screenshots as temporary local
artifacts and deliver them through channel adapters; do not expose raw shell,
paths, or artifact bytes to the model by default.

The existing trace event store, digest-bound confirmation store, and raw AI
interaction JSONL index are the shared observability and approval surfaces.
Desktop stories may extend them with typed metadata but must not create
parallel logs, pending-action state, or raw payload stores.

## Alternatives Considered

1. Expose a generic shell tool to launch apps and capture screens.
2. Embed screenshots directly into every model prompt.

## Consequences

Positive:

- Platform-specific implementation can evolve without changing AI policy.
- Media can be returned to Telegram without spending vision tokens.
- Exact actions, artifacts, and delivery can be traced and cleaned up.

Tradeoffs:

- Requires a capability registry, artifact lifecycle, and platform adapters.

## Follow-Up

- Execute US-013 through US-017 in order.
