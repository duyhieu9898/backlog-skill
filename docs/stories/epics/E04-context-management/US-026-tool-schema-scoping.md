# US-026 Intent-Scoped Tool Schema Exposure

## Status

in_progress

## Lane

normal

## Product Contract

Each provider request exposes only the reviewed native tool schemas needed for
its capability route. General conversation has no native tools. A request
needing web, files, desktop, commands, or a selected skill receives only the
minimum applicable set.

Capability routing decides model visibility; it never grants execution
authority. The effective visible tool snapshot is filtered by static policy
before provider serialization and every tool call is validated, policy-checked,
and approval-checked again by `ToolGateway` at execution.

## Relevant Product Docs

- `docs/ARCHITECTURE.md`
- `docs/CONTEXT_RULES.md`
- `docs/TOOL_REGISTRY.md`
- `docs/research/CONCEPT_OPENCLAW_CONTEXT.md`
- `docs/research/CONTEXT_MANAGEMENT_REFACTOR_PLAN.md`
- `docs/research/CONCEPT_CAPABILITY_ROUTING_AND_TOOL_SCHEMAS.md`
- `docs/decisions/0019-capability-routing-authority-boundary.md`
- `docs/stories/epics/E04-context-management/US-026-implementation-handoff.md`
- `docs/stories/epics/E01-local-operator-core/US-009-ai-tool-router.md`

## Observed Baseline

On 2026-07-17, real general-chat trace `tr_mropch57_2b339e0a` (user: "bạn là
ai") required no tool use but Gemini received all 18 native function
declarations. Local prompt attribution estimated 2,008 tool-schema tokens of
2,757 total estimated input tokens. The transcript history was only the fresh
`/new` exchange, so this finding is distinct from the resolved shared-session
history leak.

## Acceptance Criteria

- A general-chat scope sends an empty native tool declaration list and has zero
  `toolSchemas` estimated tokens.
- A `CapabilityRoute` has capabilities, target(s), continuation state,
  confidence, and a sanitized selection reason. Explicit hard signals route
  deterministically; a small route model is used only for unresolved ambiguity.
- Explicit file, web, desktop, command, and selected-skill capabilities expose
  only their reviewed static allowlist subset; an unrelated tool is absent from
  the provider request.
- Active capability scope is a bounded lease with target, task summary, source
  turn, state, and TTL. An elliptical follow-up inherits the relevant task
  scope, while a self-contained general question, cancellation, expired lease,
  completed task, or topic change clears it.
- A follow-up may elevate task context (for example file-read to file-write),
  but it cannot inherit write, execute, desktop-control, or other dangerous
  authority. Every requested call remains subject to current policy and
  approval.
- Low-confidence routing falls back to `general` with no tools; it must never
  fall back to the full catalog.
- Scope selection, lease transition, visible tool names/schema hash, and
  provider-compatible tool subset are traceable without raw prompt content.
- Existing actionable tool-loop behavior, confirmation handling, and gateway
  enforcement remain unchanged after the schema-selection change.
- Per-request token attribution continues to report schemas separately from
  system prompt, history, memory, tool evidence, and current user message.
- The implementation adds regression tests for no-tool general chat,
  representative hard-signal scoped cases, elliptical continuation, topic
  change, lease expiry, scope elevation without authority inheritance, and
  preservation of an atomic tool call/result context block.
- Real-provider validation after deployment records one general-chat trace with
  no tool declarations and one actionable scoped trace with only the expected
  declarations. Compare their `toolSchemas` attribution, not only provider
  aggregate token counts.

## Design Notes

- Make the empty general-chat set explicit rather than treating an absent scope
  as "all tools." This closes the current `ToolExecutor.definitions()`
  default-path leak.
- Use a three-stage resolver: deterministic hard signals, active-scope lease
  continuation, then a small constrained route model only if the first two are
  inconclusive. The route model receives the current message, short recent
  routing context, active-scope summary, and capability enum — never the full
  transcript, full schemas, or skill bodies.
- Start with a reviewed static capability-to-tool map and capability
  inheritance (`file-write` includes file-read; desktop-control includes
  desktop-observe). Limit direct scope to at most two capabilities and eight
  tools per turn; stage wider requests instead of exposing the full catalog.
- Resolve visible tools by applying the static map, provider support,
  availability, and authority policy. Persist that exact allowed-tool snapshot
  for the run; provider serialization uses it and execution still rechecks it.
- Skills are instruction packages, not authority. A selected skill loads its
  body on demand and unions its declared required capabilities; an ordinary
  turn receives neither the body nor skill-specific tool schemas.
- Maintain canonical internal tool definitions and provider-native encoders.
  This story must preserve current Gemini native declarations; broader
  OpenAI/Anthropic encoder parity is a follow-up when those providers are in
  scope.
- Prompt caching may lower billed cost for stable schemas, but does not satisfy
  this story because the declarations still consume context-window capacity.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Hard-signal routing, lease continuation/expiry, topic-change clearing, low-confidence no-tool fallback, static-map expansion, and non-inherited authority. |
| Integration | Provider request capture proves native Gemini payloads omit unrelated declarations; a call outside the run's visibility snapshot fails before execution while an allowed call still traverses gateway policy and approval. |
| E2E | General-chat trace has zero schema tokens; web/file/desktop follow-ups inherit only their active task scope; a new self-contained knowledge question exposes no tools. |
| Platform | Deployed logs preserve token attribution, scope/lease transition, and schema hash/tool-name summary without raw sensitive content. |
| Release | Compare pre-change baseline trace `tr_mropch57_2b339e0a` with post-change real traces; record any provider-specific discrepancy. |

## Harness Delta

No harness behavior change proposed. The story requires real-log evidence in
addition to deterministic tests because schema serialization differs by
provider.

## Evidence

- Intake #51, 2026-07-17.
- Intake #56, 2026-07-17: merged capability-routing research.
- Baseline analysis: real trace `tr_mropch57_2b339e0a`, 18 declarations,
  estimated `toolSchemas: 2008`.
- Automated implementation on 2026-07-17: deterministic capability routing,
  session-bounded active-scope leases, immutable run visibility snapshots,
  scoped Gemini declarations, and sanitized visibility telemetry. `cd agent &&
  npm run verify` passed 202 tests.
- Real-provider/deployment traces remain required before marking this story
  implemented.
