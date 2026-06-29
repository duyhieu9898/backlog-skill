# US-002 Permission Policy For Local Tools

## Status

planned

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
`docs/research/LOCAL_AGENT_ARCHITECTURE_REVIEW.md`. No implementation proof yet.
