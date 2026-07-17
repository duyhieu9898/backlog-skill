# US-028 Implementation Handoff

Date: 2026-07-17

## Authority and Dependency

- Product packet: this directory's `overview.md`, `design.md`, `execplan.md`,
  and `validation.md`.
- Accepted architecture: `docs/decisions/0018-dual-surface-desktop-control.md`.
- Research: `docs/research/CONCEPT_OPENCLAW_DESKTOP_CONTROL.md`.
- Implement after US-026 establishes continuation scope and tool visibility.
  Consume US-027 normalized media/replay contracts rather than creating a
  separate desktop token or artifact model.

## Existing Code to Reconcile

| Concern | Current owner | Handoff requirement |
| --- | --- | --- |
| Tool definition/dispatch | `agent/src/tools/executor.ts`, `agent/src/tools/gateway.ts`, `agent/src/tools/loop.ts` | Current `computer` combines screenshot, launch, keyboard, type, and coordinate click. Preserve policy gateway while introducing explicit target/action receipts. |
| Input target/frame lease | `agent/src/tools/computer/computer-tool.ts` | Existing lease is chat/display/frame based. Extend toward verified target/window lifecycle; input success must not imply postcondition success. |
| App allowlist | `agent/src/tools/computer/apps.ts`, `agent/src/config/app.ts` | Keep configured desktop apps as sole app allowlist. Do not turn model text into launch argv or CDP endpoint. |
| OS adapter | `agent/src/tools/computer/contracts.ts`, `linux-x11.ts` | Make focus-existing versus launch-if-absent observable and idempotent. Report unavailable rather than retrying launch. |
| Policy/confirmation | `agent/src/security/permissionPolicy.ts`, `agent/src/tools/contracts.ts` | Maintain current risk/approval enforcement; driver selection cannot bypass it. |
| CDP path | none yet | Add only a configured, app-verified, loopback-only driver. Never probe or connect to user-supplied/remote endpoints, and do not auto-restart arbitrary apps with debugging flags. |

## Test-First Sequence

1. `agent/test/desktop-driver-selection.test.js`
   - configured healthy loopback CDP endpoint selects CDP renderer driver;
     absent/unhealthy/unconfigured/remote endpoint selects OS driver or is
     unavailable; selection is traced.
2. `agent/test/desktop-target-lifecycle.test.js`
   - existing matching window is focused without launch; absent app launches
     once; target/window/frame mismatch and stale frame are rejected; no silent
     duplicate window.
3. `agent/test/desktop-postcondition.test.js`
   - `INPUT_INJECTED` is distinct from `POSTCONDITION_VERIFIED`; user-facing
     success requires an observable predicate; no-progress action fingerprint
     stops before global eight-step limit.
4. Extend `agent/test/computer.test.js`
   - preserve existing fixed argv, frame lease, registry, unavailable-adapter,
     and policy tests while adapting them to target receipts.
5. `agent/test/cdp-app-driver.test.js`
   - fake CDP accessibility snapshot/ref action, explicit native-dialog
     fallback to OS driver, and rejection of endpoint/owner mismatch.

## Implementation Order

1. Introduce `DesktopAppDriver`, `DesktopTarget`, action receipt,
   postcondition, and progress-state types behind pure fake-adapter tests.
2. Refactor current OS adapter to find/focus an existing configured window and
   launch only if absent. Return `focusedExisting` versus `launchedNew` in a
   sanitized receipt.
3. Bind key/type/click to target and current frame where appropriate; preserve
   current permission/approval flow and artifact retention.
4. Add postcondition evaluation and early no-progress stopping. Do not increase
   the global tool-step cap as a substitute for recovery.
5. Add the optional CDP driver behind explicit local configuration and owner/
   loopback verification. Support explicit fallback for native UI only.
6. Integrate US-027 media usage/replay and US-026 continuation visibility.
7. Run deterministic fake-adapter tests, then a human-observed disposable VS
   Code workflow: close a known tab; create a file; type `abc`; prove the
   visible result and absence of duplicate window.

## Stop Conditions

Pause and request direction if:

- X11/window manager cannot safely enumerate/focus the existing app window;
- CDP requires restarting an app, opening a non-loopback port, or owner cannot
  be verified;
- proving UI content requires an OCR/accessibility integration outside current
  authority;
- a new design would weaken confirmation, target freshness, or audit evidence.

## Completion Checklist

- [ ] OS and CDP fake-driver tests added and passing.
- [ ] Existing computer tests reconciled and passing.
- [ ] `cd agent && npm run verify` passes.
- [ ] Human-visible VS Code E2E proves close-tab and create/type postconditions.
- [ ] CDP fallback/security behavior is proven or recorded unavailable.
- [ ] Story proof flags/evidence/verify command are updated from real evidence.
