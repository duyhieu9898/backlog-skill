# US-027 Browser Action Contract And Media Token Attribution

## Status

planned

## Lane

normal

## Product Contract

Browser refs are snapshot-bound temporary capabilities: a model may act on a
ref only by presenting the exact snapshot that produced it and the matching
browser/tab state. Native browser schemas accurately express those
preconditions, return structured freshness/recovery state, and never silently
map a stale ref onto a new element.

Every model call records provider-reported usage separately from client-side
text/schema/tool-result/media estimates. Media from tool artifacts is never
relabeled as text input, and old processed media is replayed through durable
asset references and observations rather than repeated inline payloads.

## Relevant Product Docs

- `docs/ARCHITECTURE.md`
- `docs/CONTEXT_RULES.md`
- `docs/TOOL_REGISTRY.md`
- `docs/research/CONCEPT_OPENCLAW_CONTEXT.md`
- `docs/research/CONTEXT_MANAGEMENT_REFACTOR_PLAN.md`
- `docs/research/CONCEPT_BROWSER_CONTRACT_AND_MEDIA_USAGE.md`
- `docs/decisions/0020-browser-snapshot-and-media-contract.md`
- `docs/stories/epics/E04-context-management/US-027-implementation-handoff.md`
- `docs/stories/epics/E03-browser-capability/US-021-accessibility-snapshot-and-typed-actions.md`
- `docs/stories/epics/E01-local-operator-core/US-009-ai-tool-router.md`

## Observed Baseline

The first browser workflow, trace `tr_mropee4r_ce5853a0`, opened the supplied
site and captured an accessibility snapshot correctly, then made an invalid
`browser.act` call because it supplied a `ref` without `snapshotId`. Runtime
returned `ACTION_FAILED: Missing ref or snapshotId`; the model recovered by
capturing another snapshot and retrying. The native schema allowed this invalid
shape because `snapshotId` was optional.

The immediate follow-up, trace `tr_mropf3vm_09815645`, succeeded through
snapshot, click, and screenshot. Its final Gemini response reported 1,092
image prompt tokens, while local attribution reported only text-oriented
`toolSteps: 661`; media cost was not independently observable.

## Acceptance Criteria

- The native schema for a ref-based browser action requires both `ref` and
  `snapshotId`, matching runtime validation.
- Canonical internal browser actions are discriminated variants. Ref actions
  bind session, tab, snapshot, and ref; coordinate actions bind the screenshot
  and viewport state that produced their coordinates; non-ref actions require
  only their real runtime preconditions.
- The runtime validates snapshot existence/expiry, session/tab/document match,
  latest actionable revision, ref existence, and actionability before any ref
  action. Navigation, restart, closed tab, frame navigation, target replacement
  and expiry invalidate affected refs.
- Action results state mutation/ref freshness and whether a next snapshot is
  required. Structured recoverable failures distinguish missing, mismatched,
  expired, stale, invisible, covered, and detached targets. Recovery can ask
  for a new snapshot but cannot automatically rebind an old ref for a
  consequential action.
- Provider-facing tool schemas are small action-specific functions or a flat
  normalized envelope; they do not depend on provider support for union schema
  features. Provider validation and runtime validation reject the same
  malformed browser action before execution whenever possible.
- Each model call records `providerReported` totals/cache/modality details and
  independently records `clientEstimated` text, schemas, tool results, media,
  and unattributed values with estimator provenance. Provider totals are never
  reverse-engineered into observed text by subtracting a local image estimate.
- Replay keeps durable media asset references. Current/recent/active visual
  evidence hydrates selectively; processed old media is replaced by an
  informative observation marker and can rehydrate by asset ID. Rehydrating an
  asset never makes its prior browser refs actionable.
- Existing browser action, screenshot delivery, artifacts, confirmation, and
  atomic tool-call/result context behavior remain compatible.
- Tests cover missing snapshot ID, valid ref action, cross-tab/session misuse,
  navigation/restart/frame invalidation, latest-only ref freshness, a non-ref
  action, structured recovery, provider schema compatibility, media replay,
  and modality-aware usage fixtures.
- Real-provider validation repeats the Vocabulary/Grammar workflow without the
  avoidable malformed action and records non-zero media attribution for the
  screenshot-bearing request.

## Design Notes

- Do not merely mark `snapshotId` globally required if that invalidates a real
  runtime-supported non-ref action. Use canonical discriminated variants:
  ref-bound, snapshot-bound, coordinate-bound, and non-snapshot actions.
- Prefer separate provider functions (`browser_snapshot`, `browser_click`,
  `browser_type`, `browser_press`, `browser_navigate`, `browser_wait`) because
  strict provider schemas are more portable than a `oneOf`/`anyOf` union. A
  temporary flat `browser_act` envelope is acceptable only if normalized and
  validated to the canonical variant before execution.
- Start snapshot freshness with a conservative, configurable latest-actionable
  policy and bounded TTL/registry per tab. Exact default values are performance
  configuration to validate, not a permanent product invariant.
- Treat provider usage metadata as authoritative only for the fields it
  reports. Client estimates are a routing/budget guard with explicit confidence,
  not an invoice. Gemini modality details can be observed directly when
  present; other provider modality allocations may remain estimates.
- Persist media once as an asset reference with hash and dimensions; replay
  selectively hydrates current/recent/active evidence and replaces processed
  old media with a summary marker. Preserve approval and audit evidence.
- This story complements US-026. US-026 selects which tools are exposed;
  US-027 makes an exposed browser tool correct and its media cost observable.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Canonical variants, snapshot/session/tab/document/revision validation, stale error/recovery contract, and no old-ref rebinding. |
| Integration | Captured provider schemas require exact ref preconditions without unsupported union output; request/result fixtures record observed versus estimated modalities and asset-reference replay. |
| E2E | Vocabulary then Grammar completes without the malformed action; navigation forces a new snapshot; screenshot evidence is delivered while old screenshot context is represented by a marker. |
| Platform | Logs report per-call provider totals/cache/modality detail where available, independent client estimates/provenance, and sanitized snapshot/action lifecycle. |
| Release | Compare post-change traces with `tr_mropee4r_ce5853a0` and `tr_mropf3vm_09815645`; document any provider tokenizer variance. |

## Harness Delta

No harness behavior change proposed. Regression proof must include a real
provider/browser trace because the provider decides whether an artifact is sent
as inline media.

## Evidence

- Intake #52, 2026-07-17.
- Intake #58, 2026-07-17: merged browser-contract and media-usage research.
- `tr_mropee4r_ce5853a0`: one avoidable `ACTION_FAILED` from missing
  `snapshotId`.
- `tr_mropf3vm_09815645`: final provider request reported 1,092 image tokens;
  local attribution did not separate those media tokens.
- Planned; no implementation or verification has been claimed.
