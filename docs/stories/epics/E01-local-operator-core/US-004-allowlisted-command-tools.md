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
- Each command has label, cwd, fixed argv, skill slug when relevant,
  timeout, and confirmation policy.
- Wildcard commands are disabled by default.
- Commands execute without a shell and receive only a minimal environment.
- The agent captures exit code, output tail, stderr tail, duration, and error.
- Only one command can run at a time in the first release.

## Design Notes

- Commands:
  - `command.run_allowed`
  - `command.preview`
- Domain rules:
  - AI should normally emit `commandName`, not raw shell.
  - Raw shell and wildcard commands are disabled.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Alias resolution, timeout parsing, argv validation, confirmation defaults, stale catalog detection. |
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
  - `agent/src/commands.ts` executes fixed argv with `spawn(..., shell: false)`
    and a minimal environment allowlist.
  - `agent/src/core/router.ts` routes direct aliases before AI.
- Validation:
  - `npm test` in `agent/` passed on 2026-07-06 with 23/23 tests, including
    command alias resolution, preview routing, cwd resolution, success/failure,
    timeout, tracked persistence, literal shell metacharacters, minimal
    environment, stale catalog detection, and central permission refusal.
- Permission boundary:
  - US-002 now canonicalizes command cwd and enforces the configured workspace,
    denied paths, external-side-effect confirmation, and structured reason
    codes in both Router and executor.
- Hardening completed on 2026-07-06:
  - Catalog commands migrated from shell strings to fixed argv arrays.
  - Wildcard/raw-shell selection was removed from the catalog and AI contract.
  - Router confirmation replies show executable, arguments, cwd, and timeout.
  - Missing skills, stale cwd paths, invalid argv, and duplicate aliases fail
    catalog loading.
  - Child processes inherit only a small non-secret environment allowlist.
  - Stale Backlog entries were removed because `skills/backlog` is absent.
- Remaining proof:
  - Human Telegram smoke completed: the user confirmed a `bemo.checkout`
    allowlisted command on 2026-07-13.
  - Platform proof for cwd and executable resolution under systemd exists for
    preview; execution proof remains open for a harmless command.
