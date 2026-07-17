# US-028 Reliable Bounded Desktop Control

## Current Behavior

The `computer` tool combines application launch/focus, screenshot capture, and
input actions without an explicit durable target-window contract. The model can
repeatedly call `launch`, action success only confirms OS-level injection, and
the eight-step loop reaches its limit without proving the requested UI state.

Real traces on 2026-07-17 show this failure mode:

- `tr_mrophd6v_684f374e`: close-file request alternated launch, key, and
  coordinate clicks until the eight-step cap.
- `tr_mropjg0r_1250ddd1`: create-file/type request called launch six times and
  never invoked `type`.
- `tr_mropq2ar_1203a5aa`: `type("abc")` returned success, but no verified
  visual postcondition established that VS Code received the text.

## Target Behavior

Desktop control is selected by control surface, not application brand:

- `CdpAppDriver` controls a trusted, configured local CDP endpoint for a
  Chromium/Electron renderer using accessibility/DOM references.
- `ComputerUseDriver` controls OS-level windows, menus, dialogs, and apps with
  no usable CDP endpoint through the existing computer-use adapter.

The agent prefers the CDP driver for an eligible app-internal surface, falls
back to OS computer use for native UI or unavailable CDP, and never silently
widens a CDP connection beyond its configured loopback target. In either
driver, it selects a verified existing target when present, launches only when
absent, binds subsequent actions to that target, and reports success only after
a bounded observable postcondition. Repeated no-progress actions stop early
with a diagnostic instead of consuming the tool-loop limit.

## Affected Users

- Trusted local operator requesting desktop app observation or interaction.

## Affected Product Docs

- `docs/ARCHITECTURE.md`
- `docs/CONTEXT_RULES.md`
- `docs/TOOL_REGISTRY.md`
- `docs/research/CONCEPT_OPENCLAW_CONTEXT.md`
- `docs/stories/epics/E03-browser-capability/US-022-agent-multi-step-loop.md`
- `docs/stories/epics/E04-context-management/US-028-reliable-desktop-control/implementation-handoff.md`

## Non-Goals

- General unrestricted desktop automation.
- Automatically restarting an arbitrary app with a remote-debugging flag.
- Removing existing confirmation and permission controls for consequential
  actions.
- Treating a screenshot alone as semantic proof without a declared predicate.
