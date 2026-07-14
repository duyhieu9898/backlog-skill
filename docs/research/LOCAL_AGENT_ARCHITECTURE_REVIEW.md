# Local Agent Architecture Review

> Historical review (pre-ADR 0017): This analysis informed the original
> workspace/allowlist hardening work. Its recommendations about workspace-only
> access and sandbox-first hardening are not the current architecture contract.
> Refer to `docs/ARCHITECTURE.md` and ADR 0017 for the trusted-local,
> application-guardrail model.

## Purpose

This review compares the current local operator architecture with patterns used
by OpenHands, OpenClaw, Open Interpreter, Cline, and GitHub Copilot CLI. The
goal is not to copy their scale. It is to catch foundational mistakes before
file tools and the Bemo workflow make those mistakes expensive.

Reviewed local components:

- `agent/src/core/router.ts`
- `agent/src/commands.ts`
- `agent/src/storage/db.ts`
- `agent/src/storage/repositories.ts`
- `agent/src/logging/logger.ts`
- `agent/src/context/hydrator.ts`

## Executive Verdict

The current architecture is a useful baseline, not a restart candidate.
SQLite, trace IDs, named commands, expiring confirmations, timeouts, and debug
commands are appropriate for a small single-user local operator.

The main architectural risk is authority control. Policy, approval, and
execution are currently spread across the router and command runner. The
executor accepts shell strings, inherits the full process environment, and can
resolve an absolute working directory without a workspace boundary. Those
issues should be corrected before adding general file tools or allowing the AI
router to select more actions.

## What Other Agents Teach Us

### 1. Tools need typed contracts

OpenHands models each capability as a validated `Action -> Observation`
contract and keeps the tool definition separate from its executor. Tool
annotations describe whether an operation is read-only, destructive,
idempotent, or open-world.

For this project, a small TypeScript discriminated union is sufficient. We do
not need an event-sourcing framework or Pydantic-equivalent dependency.

```ts
type ToolAction =
  | { kind: "file.read"; path: string }
  | { kind: "file.write"; path: string; content: string }
  | { kind: "command.run"; commandId: string; args: string[] };

type ToolResult = {
  ok: boolean;
  code: string;
  summary: string;
  data?: unknown;
};
```

### 2. Policy must sit in front of every executor

OpenHands separates security analysis and confirmation policy from tool
execution. GitHub Copilot CLI similarly distinguishes which tools are exposed
from whether a specific invocation is allowed. Deny rules take precedence.

Our equivalent should be deterministic and small:

```text
LLM or command router
  -> typed action
  -> permission policy
  -> preview and approval when required
  -> executor
  -> structured result
  -> audit event
```

The LLM may suggest a risk level, but it must never be the authority that grants
permission.

### 3. Approval must bind the exact action

OpenClaw binds approved execution to canonical context such as executable,
arguments, working directory, and relevant files. Mature systems also make a
clear distinction between allow once, allow for a session, and durable trust.

The current pending-confirmation row does preserve a payload snapshot, which is
a good start. However, the user only sees a label and confirms by command name.
Before execution, the preview should show normalized arguments, canonical
working directory, affected paths, and external side effects. Confirmation
should reference an opaque action ID or digest for that exact preview.

### 4. Shell allowlists are harder than command allowlists

OpenClaw parses command segments, resolves executable paths, can restrict
argument patterns, and treats inline interpreter evaluation specially. This is
evidence that a regex denylist around an arbitrary shell string is not a stable
security boundary.

Named catalog commands are safe enough when they use a fixed executable and
argument vector. The wildcard command path in `agent/src/commands.ts` should
not be exposed to the model. Prefer `spawn(executable, args, { shell: false })`
for catalog commands. Keep shell execution as an explicit, always-confirmed
developer escape hatch only if it is still needed.

### 5. Filesystem scope is part of the security model

OpenClaw recommends workspace-only file access and treats sandboxing as a
separate containment layer. The current `resolveCwd()` accepts absolute paths
and does not canonicalize symlinks or verify an allowed root.

US-002 must define canonical read/write roots and perform `realpath`-aware
checks. A lexical `startsWith(workspace)` check is not enough. New output files
also require checking the nearest existing parent before creation.

### 6. Confirmation is not containment

Open Interpreter confirms code before running it, while its own safety notice
still recommends restricted environments. OpenClaw explicitly says approvals
reduce accidental execution risk but are not a filesystem policy.

For this small operator, workspace policy plus least-privilege executors comes
first. Containers, VMs, and per-skill sandboxes are later hardening options,
not prerequisites for the first useful release.

## Local Findings

### Keep

- SQLite with WAL for one local process.
- Separate chat, trace, command-run, confirmation, and runtime-state records.
- Trace IDs across routing and execution.
- Named command catalog with confirmation defaulting to true.
- Confirmation expiry and replacement of stale pending actions.
- Command timeout, bounded persisted output tail, and single-run guard.
- Telegram sender allowlisting and local debug commands.

### Fix Before General File Tools Or Bemo Writes

1. Add one centralized `PermissionPolicy` used by every local tool.
2. Introduce typed `ToolAction`, `PolicyDecision`, and `ToolResult` contracts.
3. Replace catalog shell strings with executable plus argument arrays where
   practical; remove model access to wildcard shell execution.
4. Canonicalize and enforce workspace roots for command working directories
   and file paths, including traversal and symlink tests.
5. Bind confirmation to an exact action ID and display an exact preview.
6. Stop passing all of `process.env` to every command. Provide a minimal base
   environment plus explicit per-command or per-skill variables.
7. Apply redaction before every persistence boundary. Current key-based log
   sanitization does not protect raw command strings, chat content, or command
   output tails containing secret values.
8. Add schema versioning and incremental SQLite migrations before the next
   schema change. Repeated `CREATE TABLE IF NOT EXISTS` is initialization, not
   migration.
9. On startup, mark an interrupted `currentRun` or unfinished command row as
   abandoned so `/status` does not report stale execution state.

### Defer Until Needed

- Docker or VM isolation.
- MCP compatibility.
- Multi-user roles and per-user permission stores.
- Cryptographically chained audit logs.
- Distributed queues or parallel workers.
- Full event sourcing or immutable conversation snapshots.
- LLM-based risk classification. Deterministic policy is enough for the first
  release.

## Minimal Target Architecture

```text
Telegram adapter
  -> Router / use case
      -> Tool registry
          -> typed ToolAction
              -> PermissionPolicy.evaluate(action, actor, workspace)
                  -> deny: structured refusal + audit
                  -> confirm: preview store -> exact approval
                  -> allow: executor
                      -> typed ToolResult
                          -> audit + presenter
```

SQLite remains behind repositories. The policy module remains pure and has no
Telegram, SQLite, shell, or LLM dependency. Executors do not decide whether
they are allowed to run; they require an already-authorized action and still
enforce their own path and argument invariants as defense in depth.

## Recommended Sequence

1. Implement US-002 as the pure policy and typed-action foundation.
2. Refactor US-004 command execution to argv-based execution and minimal env.
3. Implement US-003 file tools on top of the same policy.
4. Harden US-005 previews so approvals bind exact actions.
5. Harden US-001 audit redaction and SQLite migrations.
6. Prove the architecture with US-008, the Bemo late-day workflow.

## Sources

- [OpenHands Tool System](https://docs.openhands.dev/sdk/arch/tool-system)
- [OpenHands Security](https://docs.openhands.dev/sdk/arch/security)
- [OpenHands Security and Action Confirmation](https://docs.openhands.dev/sdk/guides/security)
- [OpenClaw Exec Approvals](https://github.com/openclaw/openclaw/blob/main/docs/tools/exec-approvals.md)
- [OpenClaw Gateway Security](https://github.com/openclaw/openclaw/blob/main/docs/gateway/security/index.md)
- [Open Interpreter](https://github.com/openinterpreter/open-interpreter)
- [Cline Auto Approve](https://docs.cline.bot/features/auto-approve)
- [GitHub Copilot CLI Tool Permissions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)
