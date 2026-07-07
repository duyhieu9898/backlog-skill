# E01 Local Operator Core

## Goal

Build a small local personal operator for this repo: Telegram is the chat
surface, the agent is the orchestrator, skills are capability packages, and AI
providers choose actions only through explicit tools and permissions.

The operator should not try to be a full OpenClaw replacement. It should do a
small set of local tasks reliably: inspect project state, run approved skill
commands, edit allowed files, ask for confirmation before risky actions, and
leave enough trace data to debug what happened.

## Non-Goals

- No arbitrary shell access from the model.
- No unrestricted filesystem write access.
- No browser automation in the first core release.
- No multi-user role system before the single Telegram user flow is stable.
- No migration of skill implementations into `agent/src/`.

## Phase Plan

| Phase | Outcome | Stories |
| --- | --- | --- |
| P0 Foundation | Agent has durable runtime state and trace logs. | US-001 |
| P1 Tool Safety | Agent can enforce permissions and run safe core tools. | US-002, US-003, US-004 |
| P2 Operator UX | User can preview, confirm, inspect, and debug actions. | US-005, US-006 |
| P3 Skill-Aware Workflows | Agent can discover skills and complete the Bemo late-day workflow safely. | US-007, US-008 |
| P4 AI Routing | AI provider can choose allowed tools without gaining raw system access. | US-009 |
| P5 Later Automation | Agent can run controlled scheduled checks after manual flows are proven. | US-010 |

## User Stories

| Story | Title | Lane | Status | Why It Matters |
| --- | --- | --- | --- | --- |
| US-001 | Runtime State And Trace Store | normal | in_progress | Debugging depends on persistent facts, not chat memory. |
| US-002 | Permission Policy For Local Tools | high-risk | in_progress | Central policy and command enforcement are implemented; file-tool and Telegram proof remain. |
| US-003 | Safe File Tools | high-risk | in_progress | Internal policy-gated tools pass unit/integration proof; Telegram and platform proof remain. |
| US-004 | Allowlisted Command Tools | high-risk | in_progress | Skills should run through reviewed commands, not arbitrary shell. |
| US-005 | Preview And Confirmation Flow | high-risk | in_progress | Real external effects need a deliberate user approval step. |
| US-006 | Debug And Status Commands | normal | in_progress | The user needs `/status`, `/last`, `/last-error`, and `/debug`. |
| US-007 | Skill Registry And Context Loading | normal | implemented | The agent discovers valid skills, surfaces registry errors, and loads only selected skill context. |
| US-008 | Bemo Late-Day Workflow | high-risk | in_progress | Bemo skill owns structured plan/create behavior; natural-language preview smoke remains. |
| US-009 | AI Tool Router | high-risk | in_progress | Generic policy-gated tool loop is implemented; Telegram/provider smoke remains. |
| US-010 | Scheduled Local Checks | normal | planned | Scheduling comes after manual execution is observable and reversible. |

## Recommended Implementation Order

1. US-001
2. US-002
3. US-003
4. US-004
5. US-006
6. US-007
7. US-005
8. US-009
9. US-008
10. US-010

## Release Slice

The first useful release is complete when US-001 through US-009 and the Bemo
US-008 vertical slice are implemented. At that point the agent can handle the
Bemo scenario without relying on broad OpenClaw-style filesystem or command
access:

```text
User request
  -> select Bemo skill
  -> choose allowlisted structured Bemo commands
  -> prepare a digest-bound plan inside the Bemo skill
  -> preview the confirmed create tool call
  -> confirm
  -> run allowlisted create command with JSON stdin
  -> record trace and last result
```

## Current Baseline

As of the re-baseline pass, the existing `agent/` code already has partial
implementations for runtime persistence, command execution, confirmations,
debug commands, skill registry, context hydration, and AI provider routing.

The permission policy, safe file tools, fixed-argv command hardening,
exact-action confirmations, debug commands, skill-registry hardening, and the
generic AI tool loop are implemented. The deployed `/skills` and `/status`
smoke for US-007 passed; the Bemo workflow now has a tested structured
plan/create foundation and needs a deployed read-only list plus natural-language
unconfirmed preview smoke.

The external architecture comparison and local risk review are recorded in
`docs/research/LOCAL_AGENT_ARCHITECTURE_REVIEW.md`. Its main conclusion is to
keep SQLite and the current orchestration baseline while making policy a single
mandatory boundary in front of typed tool executors.

## Validation Strategy

- Unit tests cover policy decisions, path checks, command resolution, tool
  schema validation, and context selection.
- Integration tests cover SQLite persistence, file tool behavior in a temp
  workspace, command execution with fake commands, confirmation expiry, and
  trace recording.
- Manual Telegram smoke tests cover the user-facing operator loop.
- External-service effects such as Bemo creation require preview and explicit
  confirmation before the command runs.
