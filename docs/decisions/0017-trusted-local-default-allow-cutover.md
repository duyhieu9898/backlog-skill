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
shuts down browser resources. This sequence is extracted into
`core/shutdown.ts` (`performGracefulShutdown`) behind injected dependencies so
its ordering and short-circuit behavior can be tested without process-level
side effects; `bot.ts` remains a thin entry point.

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

P2.2 audited every side-effecting code path and confirmed the gateway boundary
is intact: no adapter, scheduler, workflow, skill, or provider integration can
execute a tool without crossing `ToolGateway`. Side effects that intentionally
do NOT cross the gateway are: owner `/stop` and shutdown SIGTERM to an
already-authorized tracked command (an interrupt channel, not execution
authorization); `browserService.shutdown()` lifecycle teardown; the Telegram
reply transport; LLM provider inference egress; `appendRawAiInteraction` disk
logging (redacted, config-gated); and run/session/schedule SQLite bookkeeping.
A regression test (`test/gateway-boundary.test.js`) locks the boundary against
future drift.

P2.5 reframed the browser network policy from an inherited sandbox boundary
into guardrails. `browser/url-policy.ts` is now a pure non-configurable
guardrail: it denies only protocol escapes (`file`, `javascript`, `data`,
`chrome`, `devtools`) and SSRF/non-routable destinations — cloud metadata and
IPv4 link-local (`169.254.0.0/16`, including `169.254.169.254`), the unspecified
baseline (`0.0.0.0/8`), multicast, and reserved ranges, via the new
`isSsrfGuardedIp`. Private LAN, loopback, localhost, and intranet hostnames
pass through. The configurable navigation posture lives in
`security/permissionPolicy.ts evaluateBrowser`, which consults the guardrail,
honours an explicit `allowedHosts` entry as an owner trust declaration that
bypasses posture, and otherwise applies `permissions.browser.privateNavigation`
(private/localhost, default `"allow"`) or `publicNavigation` (public, default
`"allow"`) — `"allow"` / `"confirm"` / `"deny"`. The `privateNavigation` knob
existed before but was ignored; it is now live, so an owner may tighten private
access to `confirm` or `deny` without re-introducing the blanket block. The
owner's agent can now reach its own router, dev servers, and intranet by
default, while metadata exfiltration and protocol escapes stay blocked.

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
- **P2.1 — Gateway audit records** (commits `a85917a` + `734a500`): the gateway
  now emits a `gateway.decision` record for every allow / approval-requested /
  deny and a `gateway.executed` record for the execution result, each carrying
  `traceId`, `sessionId`, `runId`, and `toolCallId`. Records reuse the existing
  structured logger and `trace_events` sink; redaction is unchanged. A
  `ToolAuditContext` is threaded through `PreparedToolCall.audit` so
  `authorize()` and `execute()` emit without changing the decision signature;
  `toolCallId` (`tc_<uuid>`) is generated at the loop/runtime entry points and
  preserved across the approval pause/resume boundary. Covered by
  `test/gateway-audit.test.js`: allow+executed, deny (no execution record),
  approval-requested pause, and approve-resume sharing one `toolCallId`.
- **P2.2 — Side-effect bypass audit** (commit `4f75f15`): audited every
  side-effecting code path (adapters, scheduler, workflows, skills, provider
  integrations). No bypass found — `gatewayAuthorized: true` is set in exactly
  one place (`tools/gateway.ts`), `ToolExecutor.execute` is called only from the
  gateway, and `runTrackedCommand` only from the executor; every primitive
  (command, file, browser, desktop, web.capture, custom tool) funnels through
  the gateway. Skills are prompt-only; providers return a data structure the
  loop dispatches via the gateway; scheduled prepare/effect runs through
  `gateway.runCommand`. Locked by `test/gateway-boundary.test.js`.
- **P2.3 — Operational proof** (commits `e3b2388` + `100b0b5` + `c7a180d` +
  `cf2d631`): completed the operational reliability proof and closed two real
  gaps in "cancellation through approval resume". (1) `consumeScopedApproval`
  now forwards the `AbortSignal` into the resumed tool loop, so `/stop` or a run
  deadline can cancel a run mid-step after approval; the resumed run records
  `cancelled` and the first approved action still completes. (2) `/stop` now
  cancels still-pending approvals for a chat when no active run or command
  exists, so a paused run need not wait for its approval to expire. Graceful
  shutdown was extracted to `core/shutdown.ts` (`performGracefulShutdown`).
  Newly covered behaviors that previously had no test: per-session concurrency
  serialization (`test/concurrency.test.js`), run-deadline abort
  (`test/run-deadline.test.js`), raw-AI retention pruning
  (`test/ai-interaction-retention.test.js`), and `ScheduledCheckRunner`
  lifecycle (`test/scheduler-runner.test.js`); plus
  `test/approval-resume-cancel.test.js`, `test/stop-pending-approval.test.js`,
  and `test/shutdown.test.js`. Retry (provider transient, browser stale-ref,
  identical-failure circuit breaker), command timeout, artifact/snapshot
  retention, and lease-based scheduler dedup were already covered.
- **P2.4 — Scheduler reliability proof** (commit `4b239a4`): closed the remaining
  scheduler-reliability gaps with `test/scheduler-reliability.test.js`.
  At-least-once delivery: a runner that crashes after claiming a due job but
  before recording its run leaves the lease held and `next_run_at` un-advanced;
  a second runner cannot claim while the lease is live, but once the lease
  expires the job is reclaimed and runs again (at-least-once, not at-most-once).
  Idempotent run-state recording: `recordScheduledRun`'s `lease_owner` guard
  refuses to re-advance `next_run_at` on a stale retry, so a duplicate record
  appends a second `scheduled_runs` row without corrupting job state.
  Pre-approved-scope refusal: a clearly destructive command (`rm -rf /`)
  inside a configured scheduled run is denied by contextual policy at the
  gateway regardless of the scheduled grant, so the run fails and the
  destructive argv never executes. Runtime-schedule durability: a
  runtime-owned schedule survives a DB close/reopen (simulated restart).
  Lease-prevents-duplicate claim, config removal, runtime create/delete
  semantics, and `ScheduledCheckRunner` lifecycle were already covered by
  `test/scheduler.test.js` and `test/scheduler-runner.test.js`.
- **P2.5 — Browser URL/private-host restrictions as guardrails** (commit `2b31ce4`):
  split the single hard-deny network policy into a non-configurable guardrail
  and a configurable posture. `browser/url-policy.ts` now denies only protocol
  escapes and SSRF/non-routable destinations (new `isSsrfGuardedIp`: cloud
  metadata / IPv4 link-local `169.254.0.0/16`, `0.0.0.0/8`, multicast, reserved);
  private LAN, loopback, localhost, and intranet hostnames pass through.
  `security/permissionPolicy.ts evaluateBrowser` consults the guardrail, honours
  an explicit `allowedHosts` entry as an owner trust declaration that bypasses
  posture, and otherwise applies `privateNavigation`/`publicNavigation`
  (`"allow"`/`"confirm"`/`"deny"`). The `privateNavigation` config knob —
  previously declared but never read — is now live, and its default flipped from
  `"deny"` to `"allow"`, so the owner's agent reaches its own private network by
  default while metadata exfiltration and protocol escapes stay blocked.
  Reconciled `US-023` acceptance criteria and E03 README accordingly. Covered by
  `test/url-policy.test.js` (guardrail set, private-LAN default-allow, protocol
  deny, DNS catches `metadata.google.internal`) and `test/browser-safety.test.js`
  (default-allow localhost, guardrail denies `169.254.169.254`, `privateNavigation:"deny"`
  tightens).

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

1. ✅ Done (commits `a85917a` + `734a500`) — see Progress. Add/normalize gateway
   audit records for each allow, approval, deny, and execution result, with
   `traceId`, `sessionId`, `runId`, and `toolCallId`.
2. ✅ Done (commit `4f75f15`) — see Progress. Audit all side-effecting code paths
   to ensure adapters, scheduler, workflows, skills, and provider integrations
   cannot bypass `ToolGateway`. No bypass found; boundary locked by
   `test/gateway-boundary.test.js`. Intentional non-gateway side effects (owner
   `/stop` SIGTERM, browser shutdown, Telegram reply transport, LLM inference
   egress, redacted AI-interaction logging, SQLite bookkeeping) are documented
   as lifecycle/observability, not execution authorization.
3. ✅ Done (commits `e3b2388` + `100b0b5` + `c7a180d` + `cf2d631`) — see
   Progress. Complete operational proof: per-session concurrency serialization,
   cancellation through approval resume (AbortSignal forwarded on resume; `/stop`
   cancels paused approvals), deadline/retry behavior, artifact and raw-AI log
   retention, and graceful shutdown/restart (extracted to `core/shutdown.ts`).
4. ✅ Done (commit `4b239a4`) — see Progress. Complete scheduler reliability proof:
   at-least-once lease handling (a crashed runner's expired lease is reclaimed),
   idempotent run-state recording (stale retry does not double-advance
   `next_run_at`), config removal and runtime create/delete semantics (already
   covered), runtime-schedule persistence across a DB restart, and refusal of a
   destructive command that exceeds the schedule's pre-approved scope. Covered by
   `test/scheduler-reliability.test.js` plus existing `test/scheduler.test.js`
   and `test/scheduler-runner.test.js`.
5. ✅ Done (commit `2b31ce4`) — see Progress. Re-evaluate browser/CDP URL/private-host
   restrictions as guardrails rather than inherited sandbox boundaries, then
   align E03 acceptance criteria. `url-policy.ts` is a pure guardrail (protocol
   escapes + SSRF/non-routable via `isSsrfGuardedIp`); private/localhost is now
   governed by the live `privateNavigation` posture (default `allow`) in
   `permissionPolicy.evaluateBrowser`. `allowedHosts` remains as an explicit
   trust-declaration bypass. US-023 and E03 README reconciled.
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
