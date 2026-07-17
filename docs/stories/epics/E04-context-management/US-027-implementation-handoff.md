# US-027 Implementation Handoff

Date: 2026-07-17

## Authority and Dependency

- Product story: `US-027-browser-contract-and-media-attribution.md`.
- Accepted architecture: `docs/decisions/0020-browser-snapshot-and-media-contract.md`.
- Research: `docs/research/CONCEPT_BROWSER_CONTRACT_AND_MEDIA_USAGE.md`.
- Implement after the US-026 visible-tool snapshot is available, or keep one
  reviewed capability-map update with this change. Browser action functions
  must not bypass US-026 routing/authority boundaries.

## Existing Code to Reconcile

| Concern | Current owner | Handoff requirement |
| --- | --- | --- |
| Browser action schema | `agent/src/tools/executor.ts` | Current monolithic `browser` definition permits an action envelope whose nested `snapshotId` is optional. Replace with canonical variants and provider-safe action schemas. |
| Ref freshness | `agent/src/browser/ref-store.ts`, `snapshot-service.ts`, `action-executor.ts` | Existing ref store tracks latest snapshot by target and action executor can fall back to descriptor resolution. Make snapshot ownership/freshness explicit and restrict stale-ref rebinding per ADR-0020. |
| Browser loop retry | `agent/src/tools/loop.ts` | Current `STALE_ELEMENT_REF` retry re-snapshots and rebuilds the call. Preserve only safe explicit retry semantics; never silently bind an old consequential ref to a new element. |
| Confirmation/security | `agent/src/security/browser-confirmation.ts`, `agent/src/browser/action-policy.ts`, `agent/src/tools/gateway.ts` | Keep snapshot-bound confirmation and policy checks compatible with new canonical action identity/error codes. |
| Gemini media and usage | `agent/src/brain/providers/gemini.ts`, `agent/src/brain/router.ts` | Latest artifact image is injected inline; Gemini usage is currently logged raw. Normalize provider-reported modality/cache data separately from client estimates. |
| Artifact/replay | `agent/src/tools/loop.ts`, artifact store and context assembly | Preserve durable artifact references; add selective replay/marker behavior without putting base64 in transcript or reviving browser refs. |

## Test-First Sequence

1. `agent/test/browser-contract.test.js`
   - missing snapshot ID; unknown/expired snapshot; session/tab mismatch;
     document/navigation/frame/target invalidation; latest-actionable revision;
     ref missing/not actionable; structured recovery payload.
2. Update `agent/test/browser-actions.test.js` and
   `agent/test/browser-loop-retry.test.js`
   - classify old stale-descriptor fallback by action risk;
   - retain only explicitly safe retry behavior; prove consequential actions
     never auto-rebind an old ref.
3. `agent/test/browser-provider-schema.test.js`
   - action-specific provider schemas require snapshot/ref/text as appropriate;
     no unsupported union output; strict-compatible object constraints;
     canonical validator rejects invalid variant fields.
4. `agent/test/usage-normalization.test.js`
   - Gemini fixture with text/image/cache modality detail;
   - OpenAI/Anthropic fixture behavior retains aggregate observed values and
     client image estimate/provenance; no false observed-text subtraction.
5. `agent/test/media-replay.test.js`
   - asset reference persistence/deduplication; current/recent visual hydrate;
     old processed marker; rehydrate-by-asset; no historic ref revival;
     approval/audit evidence retention.

## Implementation Order

1. Introduce canonical browser action/snapshot/result/error types and pure
   validation. Keep provider encoding separate.
2. Extend ref-store identity/freshness checks and return structured error and
   recovery information. Start with a conservative configurable
   latest-actionable policy; do not hard-code research TTL values without
   measuring the live browser runtime.
3. Reconcile gateway, confirmation, and loop retry paths with the canonical
   contract. Change existing stale fallback tests before claiming the new rule.
4. Encode provider-facing browser actions as small functions, or a temporary
   flat envelope normalized before execution. Update US-026 capability metadata
   in the same change if tool names split.
5. Add normalized per-model-call usage: provider-reported totals/cache/modality
   fields plus client estimates and estimator provenance.
6. Add asset-reference replay/marker logic in the context view; retain raw
   artifacts/transcript records for audit.
7. Run deterministic tests, then repeat Vocabulary → Grammar with Gemini and
   inspect raw provider logs plus sanitized attribution.

## Required Real-Trace Proof

1. A ref action missing `snapshotId` is rejected before browser execution.
2. Vocabulary → Grammar completes with snapshot-bound action only.
3. Navigation/new snapshot forces action from a fresh snapshot.
4. Screenshot-bearing Gemini call records nonzero observed image modality when
   supplied, while local schema/text/media estimates remain separate.
5. An old browser screenshot can be represented/retrieved by asset ID but its
   old ref cannot be used for a new action.

## Completion Checklist

- [ ] Browser/usage/media tests added and passing.
- [ ] Legacy stale-ref behavior reconciled with ADR-0020.
- [ ] `cd agent && npm run verify` passes.
- [ ] US-026 capability map supports final browser schema set.
- [ ] Real-provider traces meet all five checks.
- [ ] Story proof flags/evidence/verify command are updated from real evidence.
