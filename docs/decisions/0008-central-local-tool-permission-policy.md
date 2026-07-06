# 0008 Central Local Tool Permission Policy

Date: 2026-07-03

## Status

Accepted

## Context

The local operator already runs named commands and persists confirmations, but
authority checks were spread between the Router and command executor. Working
directories were resolved without a workspace boundary, and future file tools
had no shared contract for paths, denial reasons, or confirmation requirements.

US-002 requires one deterministic boundary before local reads, mutations, and
commands. This boundary must not depend on an LLM-provided risk label.

## Decision

Add typed `ToolAction`, `PolicyDecision`, and `ToolResult` contracts. All local
tool executors must evaluate a central `PermissionPolicy` immediately before an
effect. The policy:

- canonicalizes existing paths and the nearest existing parent for new paths;
- checks command working directories and writes against a configured workspace;
- supports read roots that may be broader than write roots;
- denies `.env`, `.git`, `node_modules`, secret-like files, and configured
  system paths before applying allow or confirmation rules;
- returns `allow`, `confirm`, or `deny` with a stable reason code;
- requires confirmation for file mutations and commands marked as requiring
  confirmation or producing an external side effect.

Relative policy paths are resolved from `agent/`. The current command runner
re-checks policy as defense in depth even when the Router already evaluated the
action for preview or confirmation.

## Alternatives Considered

1. Keep checks in each Router branch. Rejected because future executors could
   bypass or implement inconsistent authority rules.
2. Trust an AI-generated risk classification. Rejected because an LLM cannot
   grant local authority deterministically.
3. Rely only on confirmation. Rejected because confirmation does not contain
   filesystem access or prevent an outside-workspace working directory.
4. Add an OS sandbox now. Deferred; workspace policy is the required first
   boundary, while process isolation remains later hardening.

## Consequences

Positive:

- Command cwd traversal and symlink escapes are refused centrally.
- Future file tools have a typed policy contract to reuse.
- User-facing refusals and audit code can rely on stable reason codes.

Tradeoffs:

- Filesystem policy depends on the current filesystem state during
  canonicalization.
- Approval is still bound to the legacy command payload rather than an opaque
  exact-action digest; US-005 owns that hardening.
- Catalog commands still use shell strings and inherited environment; US-004
  owns argv execution and minimal environment hardening.

## Verification

```bash
cd agent && npm test
```

Policy unit tests cover allowed roots, denied files/directories, new files,
traversal, symlink escape, confirmation, and command enforcement.
