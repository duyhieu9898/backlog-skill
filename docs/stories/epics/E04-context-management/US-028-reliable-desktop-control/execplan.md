# Exec Plan

## Goal

Deliver reliable, bounded desktop control that cannot confuse focus with launch
or claim an interaction succeeded without evidence.

## Scope

In scope:

- Idempotent existing-window focus versus launch-if-absent behavior.
- Optional trusted loopback CDP driver for Chromium/Electron renderer control,
  including explicit fallback to OS-level computer use.
- Window/frame-bound desktop action contracts.
- Postcondition verification and explicit unverified outcomes.
- No-progress detection before the global tool-step cap.
- Tests plus real VS Code proof for close-tab and new-file/type workflows.

Out of scope:

- Broad new desktop capabilities.
- Changes to trusted-local permissions or confirmation policy.
- Provider/tool-schema scoping (US-026) and media attribution (US-027), except
  consuming their resulting contracts.
- Starting/restarting an arbitrary installed application with remote debugging;
  that requires a separately reviewed launch/configuration path.

## Risk Classification

Risk flags:

- Existing behavior.
- External systems.
- Cross-platform.
- Weak proof.
- Audit/security.

Hard gates:

- Desktop input can alter user work. Do not weaken confirmation, target
  freshness, or verification requirements without human confirmation.

## Work Phases

1. Inspect current desktop adapter, policy, tool loop, and tests; reproduce in
   a controlled VS Code fixture.
2. Write the target/window/action/postcondition contracts, define the approved
   CDP configuration boundary, and decide whether explicit `focus` or a tagged
   `launch` result is the smallest safe OS-driver interface change.
3. Add deterministic unit and integration tests before changing production
   behavior.
4. Implement idempotent targeting, action binding, no-progress recovery, and
   sanitized trace fields.
5. Run automated verification and repeat real desktop workflows with a human
   observing the target window.
6. Record evidence, update proof status, and reconcile any new durable design
   decision.

## Stop Conditions

Pause for human confirmation if:

- Window-manager behavior prevents reliable existing-window targeting.
- CDP availability requires starting/restarting an app, opening a non-loopback
  endpoint, or attaching to an endpoint whose owning app cannot be verified.
- The requested UI predicate requires OCR, accessibility APIs, or a new
  privileged desktop integration beyond current authority.
- A design would weaken target freshness, confirmation, or raw-artifact
  retention rules.
