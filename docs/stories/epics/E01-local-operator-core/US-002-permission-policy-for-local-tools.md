# US-002 Permission Policy For Local Tools

## Status

in_progress

## Lane

high-risk

## Product Contract

The agent enforces a single permission policy before any local tool reads,
writes, deletes, patches, or runs commands.

## Relevant Product Docs

- `plan.md`
- `skills.md`
- `docs/stories/epics/E01-local-operator-core/README.md`
- `docs/research/LOCAL_AGENT_ARCHITECTURE_REVIEW.md`

## Acceptance Criteria

- A central policy module defines workspace root, allowed read roots, allowed
  write roots, denied paths, and confirmation requirements.
- `.env`, `.git`, `node_modules`, system paths, and secret-like files are denied
  by default.
- Path resolution prevents accidental writes outside the configured workspace.
- Policy decisions return structured allow/deny results with reason codes.
- Policy decisions are deterministic and cannot be granted by an LLM-provided
  risk label.
- Tool actions are typed and carry enough normalized context for policy,
  preview, execution, and audit to refer to the same operation.
- All file and command tools call the policy module before acting.

## Design Notes

- Commands:
  - No public command required.
- Domain rules:
  - Reads can be broader than writes.
  - Writes should be limited to reviewed project folders.
  - External side effects require confirmation even when command execution is
    otherwise allowed.
  - Deny rules take precedence over allow and confirmation rules.
  - Canonical paths, symlinks, and the nearest existing parent of new files
    must be checked against configured roots.

## Implementation Design

- `agent/src/tools/contracts.ts` defines typed tool actions, structured policy
  decisions, stable reason codes, and structured tool results.
- `agent/src/security/permissionPolicy.ts` is the central deterministic policy.
  It has no Telegram, SQLite, shell, or LLM dependency.
- `agent/src/config/app.ts` loads workspace, read-root, write-root, and denied
  path configuration. Relative paths resolve from `agent/`.
- `agent/src/core/router.ts` uses policy output to refuse, request confirmation,
  or execute commands.
- `agent/src/commands.ts` re-evaluates policy immediately before execution so a
  caller cannot bypass the Router's initial decision.
- Exact-action confirmation digests, argv execution, minimal environment, and
  file executor implementation remain owned by US-005, US-004, and US-003.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Allow/deny matrix for root paths, `.env`, traversal, symlinks if supported, and allowed folders. |
| Integration | File/command tools refuse policy-denied operations. |
| E2E | Telegram request to read or edit a denied file returns a clear refusal. |
| Platform | Works with service cwd and relative paths. |
| Release | Policy config documented in agent README or config example. |

## Harness Delta

High-risk story because this defines local authority boundaries.

## Evidence

Architecture research completed in
`docs/research/LOCAL_AGENT_ARCHITECTURE_REVIEW.md`.

Implementation slice completed on 2026-07-03:

- Central policy, typed actions, configuration, Router enforcement, and
  executor defense-in-depth are implemented.
- `cd agent && npm test` passed 18/18 tests after US-003 added policy-gated
  file executors.
- Tests cover canonical roots, denied `.env`/`.git`, write confirmation,
  outside-root refusal, symlink escape, and command refusal before execution.
- Decision recorded in
  `docs/decisions/0008-central-local-tool-permission-policy.md`.

Remaining proof before completion:

- Telegram/provider E2E must show a clear denied-file refusal through the
  routed file-tool path.
- Platform proof for command cwd exists via installed-service command previews;
  file-tool cwd/path proof under the installed service remains open.
