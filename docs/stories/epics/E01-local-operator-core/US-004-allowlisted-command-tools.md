# US-004 Allowlisted Command Tools

## Status

in_progress

## Lane

high-risk

## Product Contract

The agent can run local commands only when they are declared in
`agent/commands.json` or another reviewed command registry.

## Relevant Product Docs

- `plan.md`
- `skills.md`
- `agent/README.md`
- `docs/stories/epics/E01-local-operator-core/README.md`

## Acceptance Criteria

- Commands are resolved by name or alias from an allowlist.
- Each command has label, cwd, command string, skill slug when relevant,
  timeout, and confirmation policy.
- Wildcard commands are disabled by default.
- Denylist rejects dangerous patterns before execution.
- The agent captures exit code, output tail, stderr tail, duration, and error.
- Only one command can run at a time in the first release.

## Design Notes

- Commands:
  - `command.run_allowed`
  - `command.preview`
- Domain rules:
  - AI should normally emit `commandName`, not raw shell.
  - Raw shell is allowed only for future trusted wildcard commands.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Alias resolution, timeout parsing, denylist, confirmation defaults. |
| Integration | Fake allowlisted command succeeds, fails, times out, and records output. |
| E2E | Telegram command alias runs without AI. |
| Platform | Works from service process and resolves relative cwd correctly. |
| Release | `/commands` lists allowlisted commands grouped by skill. |

## Harness Delta

High-risk because this grants local execution authority.

## Evidence

- Existing implementation:
  - `agent/commands.json` defines an `allow` command catalog with command names,
    aliases, cwd, labels, skill slugs, and confirmation flags.
  - `agent/src/commands.ts` resolves aliases, applies confirmation defaults,
    runs commands, records output tails, and blocks concurrent command runs.
  - `agent/src/commands.ts` has a denylist for trusted wildcard raw commands.
  - `agent/src/core/router.ts` routes direct aliases before AI.
- Validation:
  - `npm test` in `agent/` passed on 2026-06-26 with 10/10 tests, including
    command alias resolution, cwd resolution, command success/failure, tracked
    persistence, and wildcard denylist coverage.
- Gaps:
  - Command execution still uses shell execution through `exec`.
  - Cwd and command policy are not centralized with file/tool permissions.
  - `command.preview` is not implemented as a separate tool.
  - Stale allowlist entries can point at removed skill folders.
