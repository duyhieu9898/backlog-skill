# US-026 Implementation Handoff

Date: 2026-07-17

## Authority

- Product story: `US-026-tool-schema-scoping.md`.
- Accepted architecture: `docs/decisions/0019-capability-routing-authority-boundary.md`.
- Research rationale: `docs/research/CONCEPT_CAPABILITY_ROUTING_AND_TOOL_SCHEMAS.md`.
- This handoff is an implementation sequence, not a replacement for those
  documents.

## Baseline to Preserve

- Commit before this handoff: `6983a09`.
- `cd agent && npm run verify` passed 198 tests at commit `60bd0db`.
- Baseline failure: `tr_mropch57_2b339e0a` sent all 18 Gemini declarations to
  a general-chat request (`toolSchemas: 2008`).
- Existing context refactor is already committed. Do not reopen session
  isolation, checkpoint, memory, or token-tail work as part of US-026 unless a
  concrete regression requires it.

## Current Source Boundaries

| Concern | Current owner | Required change |
| --- | --- | --- |
| Rule-based scope detection | `agent/src/context/hydrator.ts` | Replace boolean `AiToolScope` selection with capability routing and bounded active-scope lease resolution. |
| Prompt contract | `agent/src/brain/provider.ts` | Add typed capability route/visible-tool snapshot fields without putting authority in model-controlled data. |
| Tool visibility | `agent/src/tools/executor.ts` (`definitions`) | Replace unscoped `undefined => all tools` fallback with an explicit capability-to-tool resolver. |
| Loop/run snapshot | `agent/src/tools/loop.ts` | Resolve tools once per run and keep that exact visible set for all loop iterations and prepare validation. |
| Provider request/logging | `agent/src/brain/router.ts`, provider adapters | Preserve native Gemini function declarations; trace capability route, lease transition, visible names, and stable schema hash without raw prompt content. |
| Runtime policy | `agent/src/tools/gateway.ts`, `agent/src/tools/executor.ts` | Do not weaken gateway, schema validation, current policy, or approval checks. An allowed visible set is not an execution grant. |

## Test-First Sequence

Add dedicated tests before each production slice. Suggested files:

1. `agent/test/capability-routing.test.js`
   - hard signals: general, web, file-read, file-write, desktop observe/control,
     explicit skill;
   - low-confidence/unknown route is `general` with no tools;
   - capability inheritance expands read-only prerequisites but not authority.
2. `agent/test/active-scope-lease.test.js`
   - “click cái thứ hai” inherits active web/desktop target;
   - “sửa nó đi” can elevate file-read task context to file-write capability;
   - self-contained knowledge question, cancellation, completed task, and TTL
     expiry clear the lease;
   - no write/execute/control approval is inherited.
3. `agent/test/visible-tool-snapshot.test.js`
   - general gets `[]` and zero schema-token attribution;
   - each capability receives exactly its reviewed subset;
   - a tool outside the run snapshot is rejected before prepare/execute;
   - an in-snapshot risky tool still reaches current gateway approval behavior;
   - loop iterations use one immutable visible-tool snapshot.
4. Extend provider capture tests (currently `agent/test/tool-loop.test.js` and
   `agent/test/logging.test.js`)
   - native Gemini request contains no declarations for general chat;
   - scoped request omits unrelated declarations;
   - log contains sanitized capability/lease/schema-hash fields and existing
     token attribution remains split by schemas/history/etc.

## Implementation Order

1. Define pure `Capability`, `CapabilityRoute`, `ActiveScopeLease`, and
   `VisibleToolSnapshot` types plus deterministic resolver tests. Keep this
   code provider-free and side-effect-free.
2. Add a reviewed registry-backed capability-to-tool map. Do not scatter tool
   names through `ContextHydrator`; preserve an extension point for US-027 to
   split browser actions into multiple provider functions.
3. Persist/load only the bounded active-scope lease data required for the
   current session. Reuse the established SQLite migration/repository pattern;
   do not infer continuation from the entire transcript.
4. Make `ContextHydrator` produce route/lease information. A new topic or low
   confidence must explicitly produce `general`, never `undefined`/all tools.
5. Resolve the visible-tool snapshot once in `AgentToolLoop`; pass it to the
   provider and reuse it for tool preparation. Keep `ToolGateway` as the
   execution-time policy/approval boundary.
6. Add sanitized route/lease/snapshot observability and request-capture tests.
7. Run the full suite, rebuild `dist`, then perform real-provider checks after
   deployment.

## Compatibility Constraints

- Existing direct commands and approval-resume flows must retain their current
  stable chat/session semantics.
- Skill body loading remains on demand. Selecting a skill may add only its
  declared required capabilities; skills do not grant authority.
- Provider adapters continue using their native current interfaces. Do not add
  a second routing-model API call for clear hard-signal messages.
- If an optional small routing model is later added for ambiguous messages, it
  receives only current message, short routing context, active lease summary,
  and capability enum. It cannot receive full schemas or grant authority.
- US-027 may replace `browser` with smaller action functions. The resolver
  must accommodate that by registry metadata or a single reviewed map update.

## Required Real-Trace Proof

After automated tests and service deployment, record:

1. General chat (“bạn là ai” or equivalent): no Gemini function declarations,
   `toolSchemas: 0` in local attribution.
2. Explicit web or desktop action: only expected capability declarations.
3. Elliptical continuation (“click cái thứ hai”): inherits the active target
   scope, not the whole catalog.
4. New self-contained question after an active tool task: tool declarations
   return to zero.
5. A risky action in an otherwise inherited task: current policy/approval still
   pauses or blocks it as before.

## Completion Checklist

- [ ] All US-026 unit/integration tests added and passing.
- [ ] `cd agent && npm run verify` passes.
- [ ] Harness proof flags updated only with actual evidence.
- [ ] Real-provider traces meet the five required checks.
- [ ] Story evidence and verification command are updated.
- [ ] No ADR or research document needs revision from implementation findings.
