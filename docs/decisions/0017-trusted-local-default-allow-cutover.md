# 0017 Trusted Local Default-Allow Cutover

Date: 2026-07-14

## Status

Accepted

## Context

The original local-operator implementation treats command catalogs, workspace
roots, and exact confirmation tokens as primary authority boundaries. That
model prevents the owner’s personal agent from performing new legitimate work
on its own Ubuntu machine and conflicts with the trusted-local architecture.

## Decision

Replace the root/allowlist-first model in P0 with contextual default allow,
scoped approval for significant actions, and hard deny for evident destructive
actions. All tool execution crosses \`ToolGateway\`, where policy runs before
execution.

Telegram exposes Approve/Reject buttons and CLI exposes a short pending-action
ID or interactive confirmation. Digest binding remains backend-only: it binds
pending action, run, owner/chat, expiry, and action content; a changed action
invalidates its pending approval.

## Alternatives Considered

1. Retain the allowlist as compatibility mode. Rejected: it leaves two
   conflicting authority models and delays the intended cutover.
2. Expose digest tokens in the user interface. Rejected: users approve scope,
   not cryptographic implementation details.

## Consequences

Positive:

- The personal agent can perform legitimate new local tasks without catalog
  maintenance or repeated prompts.
- Approval remains protected from stale, replayed, or changed actions.

Tradeoffs:

- P0 deliberately invalidates assumptions in ADRs 0008–0011 and 0014–0015;
  those documents must be superseded as their implementations migrate.
- Destructive-pattern classification requires focused tests and conservative
  maintenance.

## Implementation Record

The legacy `pending_confirmations` table and `confirm <digest>` handlers were
removed in the P0 cutover. Pending approvals now use only
`pending_approvals`, with a short UI ID and a backend digest bound to owner,
chat, run, expiry, and action content. A scheduled effect receives the
configured owner principal separately from its delivery chat, so an approval
cannot accidentally be bound to a chat ID in place of the owner.

P0 also introduced the generic `command.run` tool. It accepts validated argv
or a necessary shell command with cwd, bounded output, timeout, a reduced
environment, and process-group termination. Named catalog commands remain as
shortcuts for existing workflows, not as a permission allowlist; every generic
and named command is evaluated for destructive and significant-impact patterns
at the gateway.

The gateway now performs the final browser/desktop policy check and consumes
the browser action grant immediately before dispatch. `ToolExecutor` rejects a
direct call that was not authorized by the gateway. The original owner request
is propagated as task intent, so a matching request such as “install and
configure Nginx” covers its ordinary `sudo apt` and `systemctl` steps while a
clearly destructive command remains denied.

P1 begins with `runtime/AgentRuntime` as the owner of persisted run creation,
terminal/pause transitions, conversation persistence, compaction trigger,
context hydration, and the tool-loop entry point. `Router` now supplies
transport/command routing rather than owning that lifecycle directly.
Each executed tool call and result is now appended to `run_steps`, preserving
ordered run-local evidence across the approval pause/resume boundary.

Raw AI interaction recording now has an explicit enable/disable setting and
day-based retention. Structured fields and common bearer/token/password/cookie
forms are redacted before operational or raw-AI log persistence.

Approved pending actions now also create an expiring persisted run grant. The
gateway consults it for the same action family in that run, so equivalent file
or command steps do not repeatedly prompt. Browser effect confirmation remains
snapshot/action-fingerprint-bound and is not widened into a general browser
grant.

Configured schedules now execute their declared prepare/effect workflow as
pre-approved behavior through `ToolGateway`; they no longer mint a new
approval for every recurrence. A failed or malformed configured effect fails
the scheduled run and is surfaced through its normal notification/audit path.

Scheduled jobs now persist `source` (`config` or `runtime`) and an IANA
timezone. Config seed is authoritative for config-owned schedule attributes and
disables a config-owned entry removed from `config.json`. It cannot overwrite a
runtime-owned row with the same stable schedule ID.

`AgentRuntime` now owns command dispatch for adapter commands and scheduler
runs. Scheduler execution creates a persisted scheduler run (unless nested in
a manual adapter run), dispatches each scheduled command through the runtime's
`ToolGateway`, and persists its ordered tool steps.

Graceful process shutdown stops the scheduler, requests termination of the
active command process group, waits a bounded time for it to close, and then
shuts down browser resources.

The legacy `desktopCaptureRequiresConfirmation` switch was removed. A declared
and available desktop capability is ordinary local automation and is allowed by
default; task-level approval remains the place to gate a consequential action,
not each click or capture.

Runs now have a configurable deadline and an `AbortSignal` owned by
`AgentRuntime`. Cancellation reaches `ToolGateway`, `ToolExecutor`, and the
command process group; a cancelled persisted run is terminally recorded as
`cancelled`, not `completed` or `failed`.

Legacy filesystem allowed-root configuration was removed. Paths are normalized
and symlink-resolved, sensitive material still requires approval, and clearly
destructive actions are denied, but arbitrary owner-relevant filesystem paths
are not rejected merely for being outside a predeclared root.

The scheduler no longer restricts configured schedules to read-only commands.
A configured schedule is the owner's pre-approved scope and runs through the
same runtime/gateway/policy path; any newly destructive command is still
denied by contextual policy at execution time.

Runtime schedules can now be created and deleted independently. They persist
with `source: 'runtime'`, cannot replace a config-owned schedule ID, and are
not changed by later config seeding.

Custom tools use a source-managed `ToolRegistry`. Tool modules are registered
explicitly from `src/tools/register-tools.ts` with `registerTool(...)`; there
is deliberately no directory scan, dynamic import, or drop-in plugin loading
in this phase. The resulting definition is still resolved and authorized by
`ToolGateway` before `ToolExecutor` invokes it. This provides a small,
type-checked lifecycle without creating a second execution path.

## Progress

- **P1.1 — ToolRegistry** (commit `a24a98b`): added `src/tools/registry.ts` and
  `src/tools/register-tools.ts`, `ensureToolsRegistered()` from the
  `ToolGateway` constructor, and `authorize()` of custom tools by
  `ToolRiskLevel` (routine/sensitive/destructive). Built-in tools are unchanged;
  the registry is empty by default. Covered by `test/custom-tools.test.js`.
- **P1.2 — Extended approval matching** (commit `1a9ccdb`): `covers()` now
  matches an `ActionProfile` (family, risk category, resource/command hints)
  against active grants within scope, via `security/actionProfile.ts` and the
  shared `security/policy-patterns.ts`. `resolve()` populates real grant fields
  from the profile; `revokeApprovalGrant` added. Legacy grants
  (`["approved-action"]`, no resourceHints) remain backward-compatible and
  browser confirmations stay fingerprint-bound (never widen). Covered by
  `test/approval-matching.test.js`.
- **P1.3 — Persisted approval restart** (commit `c50ed31`): approvals now survive
  a DB close/reopen (simulated process restart) and resume the tool loop. Added
  an `AGENT_DB_FILE` env override in `config/paths.ts` (mirroring
  `AGENT_CONFIG_FILE`) and made `getDb()` create the DB parent directory, so a
  test can run against an isolated temp database. Covered by
  `test/approval-restart.test.js`: approve-resume, reject-cancel, stale-digest
  invalidation, and replay refusal — the last exercised across two restarts.

## Follow-Up

### P1: Close the core authority model

1. ✅ Done (commit `a24a98b`) — see Progress. Implement the source-managed
   custom `ToolRegistry` and `src/tools/register-tools.ts`, with explicit
   `registerTool(...)` calls. Resolve custom tools through `ToolGateway` before
   `ToolExecutor`; test routine, sensitive, and destructive custom-tool
   definitions.
2. ✅ Done (commit `1a9ccdb`) — see Progress. Extend approval matching beyond a
   tool-name hint: match the current task, action family, risk category,
   relevant resource/command hints, and scope. Exercise `run`, `session`,
   `schedule`, and persistent grants, expiry, and revocation without asking
   again for equivalent in-scope steps.
3. ✅ Done (commit `c50ed31`) — see Progress. Prove persisted approval
   pause/resume across a process restart, including stale digest invalidation,
   replay/refusal handling, rejection, and continued tool-loop execution after
   approval.

### P2: Reliability, audit, and migration proof

1. Add/normalize gateway audit records for each allow, approval, deny, and
   execution result, with `traceId`, `sessionId`, `runId`, and `toolCallId`.
2. Audit all side-effecting code paths to ensure adapters, scheduler,
   workflows, skills, and provider integrations cannot bypass `ToolGateway`.
3. Complete operational proof: per-session concurrency locking, cancellation
   through approval resume, deadline/retry behavior, artifact/log retention,
   and graceful shutdown/restart.
4. Complete scheduler reliability proof: at-least-once lease handling,
   idempotent side effects where relevant, config removal, runtime-schedule
   persistence, and pause on behavior that exceeds pre-approved scope.
5. Re-evaluate browser/CDP URL/private-host restrictions as guardrails rather
   than inherited sandbox boundaries, then align E03 acceptance criteria.
6. Rename remaining active source/test terminology from “allowlist” to command
   shortcut where appropriate; keep legacy names only where compatibility or
   historical evidence requires them.
7. Run final migration proof: TypeScript and full regression suite, SQLite
   migration from an existing database, CLI and Telegram approval smoke,
   scheduler smoke, destructive-command refusal, and one real custom-tool
   execution.

### Documentation rule

The migration notices in the E01/E02/E03 parent documents prevent legacy
stories from acting as current architecture. Reconcile each child story and the
test matrix when its associated implementation changes; do not erase its
historical evidence merely to match new terminology.
