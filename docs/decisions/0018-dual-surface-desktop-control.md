# 0018 Dual-Surface Desktop Control

Date: 2026-07-17

## Status

Accepted

## Context

US-028 baseline traces show screenshot/keyboard desktop control can repeatedly
launch or focus an ambiguous window, consume the tool-loop budget, and report
OS-level input injection as completion. Chromium/Electron applications can
sometimes offer a more precise renderer control surface through a local Chrome
DevTools Protocol (CDP) endpoint, but CDP cannot control native dialogs,
menus, or the operating-system desktop and grants powerful application access.

## Decision

Model desktop automation by control surface rather than application name.
US-028 will define a common `DesktopAppDriver` with two implementations:

- `ComputerUseDriver` for OS-level screenshot/accessibility/pointer/keyboard
  control, including native UI and the fallback path.
- `CdpAppDriver` for an explicitly configured, app-verified, loopback-only CDP
  endpoint controlling a Chromium/Electron renderer through DOM/accessibility
  references.

Driver selection is explicit and traced. CDP is preferred only for an eligible
renderer target; native UI or unavailable CDP falls back explicitly to OS
control. This decision does not authorize auto-restarting an arbitrary app with
remote debugging or connecting to user-supplied/remote CDP URLs.

## Alternatives Considered

1. OS-level computer use only. Rejected because renderer references offer a
   more precise, lower-image-cost control surface where a trusted endpoint
   exists.
2. CDP only for Electron apps. Rejected because native UI remains outside the
   renderer and many apps do not expose a safe endpoint.
3. Identify drivers solely by application name. Rejected because availability
   depends on the control surface and configuration, not the brand.

## Consequences

Positive:

- Precise CDP operations can reduce coordinate and screenshot dependence.
- OS control remains available for native UI and non-Chromium applications.
- Explicit endpoint policy limits CDP's powerful authority.

Tradeoffs:

- Adds driver-selection, lifecycle, and fallback tests.
- CDP setup/launch is intentionally deferred until separately approved.

## Follow-Up

- Implement only through US-028 after its high-risk validation plan is ready.
- Reconcile the final config and endpoint ownership rules in `docs/TOOL_REGISTRY.md`.
