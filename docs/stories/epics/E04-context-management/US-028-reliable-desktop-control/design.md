# Design

## Domain Model

- `DesktopTarget`: configured app identity, selected `windowId`, title, and
  current `frameId`.
- `DesktopActionReceipt`: target identity, before/after frame IDs, artifact,
  and structured execution outcome.
- `Postcondition`: a bounded observable predicate for the requested task, or
  an explicit declaration that verification is unavailable.
- `ProgressState`: normalized action fingerprint and target/frame evidence used
  to detect no-progress repetition.
- `DesktopAppDriver`: common `inspect`, `act`, and `close` boundary implemented
  by `ComputerUseDriver` and optional `CdpAppDriver`.
- `CdpTarget`: approved loopback endpoint, app identity, renderer target, and
  CDP session; it is not a generic remote browser URL.

## Application Flow

1. Resolve a configured app target. If it has a healthy approved loopback CDP
   endpoint and the requested surface is renderer-owned, select `CdpAppDriver`.
   Otherwise select `ComputerUseDriver`.
2. The OS driver enumerates/focuses a matching existing window and launches
   only if none is available. The CDP driver attaches to its configured
   renderer; it never opens an arbitrary endpoint.
3. Return a verified target and fresh observation: a frame artifact for OS
   control or an accessibility/DOM snapshot for CDP.
4. Require later UI actions to reference that target; reject stale/mismatched
   target or frame where coordinate safety requires freshness.
5. When renderer control reaches a native dialog/menu or CDP becomes
   unavailable, use an explicit, traced fallback to the OS driver.
6. After an action, evaluate the declared postcondition from a fresh artifact,
   accessibility snapshot, DOM state, or other adapter-provided state.
7. Continue only while state advances. On repeated no-progress, return a
   structured diagnostic before the global eight-step ceiling.

## Interface Contract

- Split ambiguous start/focus semantics into explicit operations or provide a
  result field that unambiguously says `focusedExisting` versus `launchedNew`.
- `key` and `type` bind to a verified `DesktopTarget`; coordinate click also
  requires the exact current `frameId`.
- CDP actions use snapshot-scoped accessibility/DOM references rather than
  screen coordinates. CDP endpoint configuration is allowlisted, loopback-only,
  and traceable; it is never inferred from arbitrary user text.
- Tool results distinguish `INPUT_INJECTED` from `POSTCONDITION_VERIFIED`.
- Success text shown to the user must depend on a verified postcondition, not
  merely the input-injection receipt.

## Data Model

Persist no new long-lived desktop screenshots by default. Existing artifact
retention applies. Trace sanitized target/window lifecycle, action receipts,
postcondition result, and early no-progress stop reason; do not record raw
screen content in SQLite trace events.

## UI / Platform Impact

Desktop adapters must be idempotent across the supported local window manager:
focusing an existing VS Code window must not silently create another window.
CDP is an application-internal driver, not a replacement for native desktop
surfaces; native menus/dialogs remain an OS-driver responsibility. Platform-
specific inability to enumerate/focus or connect to configured CDP is reported
as unavailable, not papered over by repeatedly launching or probing ports.

## Observability

Record selected driver, app ID, whether focus versus launch occurred, safe
window/renderer identifier, explicit driver fallback, frame/snapshot
transition, action fingerprint, postcondition status, and no-progress counter.
Attribute screenshot media separately per US-027.

## Alternatives Considered

1. Keep a prompt-only rule to launch once. Rejected: the traces show the model
   can violate it and the adapter has no stateful guard.
2. Raise the eight-step limit. Rejected: this hides repetition and raises cost
   and unintended-interaction risk.
3. Treat OS input success as task success. Rejected: focus and rendered state
   remain unverified.
4. Use CDP for every part of an Electron app. Rejected: native dialogs and
   OS-rendered UI are outside the Chromium renderer.
