# Browser Contract And Media Usage Research

Source: user-supplied research for US-027, 2026-07-17.

## Conclusions for `my-agent`

1. Every browser action using a `ref` must also carry the exact `snapshotId`
   that produced it.
2. Snapshot/ref is a temporary capability, not a reusable selector.
3. Use a discriminated-union canonical action contract internally, but encode
   small per-action provider functions rather than relying on provider support
   for `oneOf`/`anyOf`.
4. Keep provider-reported usage separate from client estimates; image/media
   tokens must never be relabelled as text input tokens.

OpenClaw documentation requires refs originating from a snapshot and warns that
they become unstable across navigation, target changes, and iframe scope. Its
public action surface chiefly carries ref and target, so requiring `snapshotId`
in `my-agent` is an intentionally stricter contract that makes the runtime
precondition explicit.

## Canonical browser action contract

All actions have browser-session, tab, and request identity. Snapshot-bound
actions additionally have `snapshotId`; ref-bound actions additionally have
`ref`.

```ts
interface BrowserActionBase {
  browserSessionId: string
  tabId: string
  requestId: string
}

interface SnapshotBoundAction extends BrowserActionBase {
  snapshotId: string
}

interface RefBoundAction extends SnapshotBoundAction {
  ref: string
}
```

`click`, `type`, `hover`, `select`, element-scoped `press`, and ref-based drag
are ref-bound. `navigate` is not snapshot-bound. Page-scoped `press` is
snapshot-bound. Coordinate actions must bind to the screenshot/visual state
that motivated the coordinates, including viewport dimensions and scale.

```ts
type BrowserAction =
  | BrowserClickAction
  | BrowserTypeAction
  | BrowserHoverAction
  | BrowserSelectAction
  | BrowserScrollIntoViewAction
  | BrowserDragAction
  | BrowserPressAction
  | BrowserClickCoordinatesAction
  | BrowserNavigateAction
  | BrowserWaitAction
```

## Snapshot and reference identity

A `BrowserSnapshot` is an opaque resource with `snapshotId`, browser session,
profile, tab, diagnostic target ID, document ID, revision, optional frame,
creation/expiry times, refs, text snapshot, and optional screenshot asset.
The model copies its opaque ID; it must not construct one from tab/revision.

Each ref records semantic role/name, optional frame/backend node identity,
actionability, and optional bounding box. A runtime registry indexes snapshots
by session, tab, target epoch, document/revision, frame, ref map, and TTL.

Before a ref action runs, validate in order:

1. snapshot exists and is unexpired;
2. browser session and tab match the action;
3. its document matches current tab document;
4. it is the latest actionable snapshot for that tab;
5. the ref exists and is actionable.

Hard-stale events include top-level navigation/reload, browser or CDP restart,
tab close, frame detach/navigation, target replacement, session change, and
TTL expiry. Major DOM changes, SPA route changes, modals, submit, scroll,
resize, or zoom should require a fresh snapshot. Initial policy proposed by
the research is `latest-only`, five-minute TTL, and two snapshots per tab.

## Result and error contract

Browser action results should describe mutation (`none`, `minor-dom`,
`major-dom`, `navigation`, `frame-navigation`, or `tab-replacement`), ref state
(`still-valid`, `possibly-stale`, or `invalid`), and
`nextSnapshotRequired`, plus current tab/document/URL/title when available.

Errors are structured and recoverable where appropriate:

```text
SNAPSHOT_REQUIRED                 SNAPSHOT_NOT_FOUND
SNAPSHOT_EXPIRED                  SNAPSHOT_SESSION_MISMATCH
SNAPSHOT_TAB_MISMATCH             SNAPSHOT_STALE_NAVIGATION
SNAPSHOT_STALE_REVISION           FRAME_STALE
REF_NOT_FOUND                     REF_NOT_ACTIONABLE
ELEMENT_DETACHED                  ELEMENT_NOT_VISIBLE
ELEMENT_COVERED                   TARGET_CHANGED
```

Recovery may explicitly require `snapshot`, `select-tab`, or
`restart-browser`. Runtime may snapshot once for a retry but must not map an old
ref onto a new element and click it automatically for consequential actions.

## Provider schemas

The canonical internal schema can be a true discriminated union and be runtime
validated by AJV or equivalent. Provider definitions should instead be small
functions such as:

```text
browser_snapshot
browser_click
browser_type
browser_press
browser_navigate
browser_wait
```

This avoids provider differences around union schema support, removes
irrelevant fields, makes strict validation easier, and permits per-action risk
and approval treatment. A strict `browser_click` definition requires session,
tab, snapshot ID, ref, and nullable click count with
`additionalProperties: false`.

If a single provider tool must remain (`browser_act`), use a flat envelope with
a `kind` enum and nullable fields, then normalize/validate it into the
canonical union before execution. The flat envelope is portable but less safe
than separate action functions.

## Usage: observed versus estimated

Do not retain only `inputTokens` and `cachedTokens`. Every model call should
record purpose (`main`, `tool-loop`, `router`, `compaction`, or `memory-flush`)
and two independent views:

```ts
interface ProviderReportedUsage {
  inputTokensTotal?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  inputByModality?: { text?: number; image?: number; audio?: number; video?: number; document?: number }
  cachedByModality?: { text?: number; image?: number; audio?: number; video?: number; document?: number }
  raw: unknown
}

interface ClientEstimatedUsage {
  textTokens?: number
  toolSchemaTokens?: number
  toolResultTokens?: number
  imageTokens?: number
  audioTokens?: number
  videoTokens?: number
  documentTokens?: number
  unattributed?: number
  estimator: { name: string; version: string; confidence: string }
}
```

Never derive “observed text” by subtracting a client image estimate from a
provider total: cache, provider resizing/tokenization, safety wrappers, tools,
and multi-call turns make that invalid. Store provenance and uncertainty.

Gemini has modality details (`promptTokensDetails`, `cacheTokensDetails`) and
may provide provider-exact image/text values. OpenAI and Anthropic commonly
require client-side image estimates made from the post-resize request; their
cache totals must remain provider-reported aggregates. Turn billing is the sum
of calls, while context occupancy is the latest request only.

## Media asset and replay policy

Persist media once in an asset store (asset ID, SHA-256, MIME, bytes,
dimensions, URI, thumbnail/OCR/visual summary derivatives). The durable
transcript stores an `image_ref`, never repeated base64. Deduplicate by hash.

The replay view hydrates media selectively:

- Current-turn images, latest browser screenshot, pending-approval evidence,
  active before/after comparison, and explicitly requested earlier images stay
  available.
- Keep up to three recent completed turns, up to four active images, and a
  bounded image-input budget (the research proposes 6,000 tokens).
- Old processed images are replaced with an informative marker containing
  asset ID, snapshot ID, dimensions, and persisted visual observation.
- A browser tab normally keeps only its latest screenshot in replay; text or
  accessibility snapshot is the primary planning source.
- Rehydrate old media by asset ID on demand. Rehydration never revives an old
  browser ref; action requires a fresh snapshot.

Do not prune current/unprocessed user media, pending approval evidence,
consequential-action before state, active latest tab state, comparison pairs,
in-flight tool references, or audit evidence. Prune superseded screenshots,
fully described old tool images, duplicates, stale-ref discovery images, and
irrelevant thumbnails. Preserve prompt-cache stability where useful, but keep
an absolute bound (proposed: at most two hydrated browser screenshots).

## Required US-027 tests

Contract tests must cover missing snapshot ID, cross-tab ref use, navigation,
new snapshot invalidating previous actionable snapshot, process restart, and
frame navigation. Provider schema tests must reject unsupported union output,
require snapshot ID for click/type, and enforce strict OpenAI-compatible
objects. Media tests must prove durable asset references, replay markers,
recent-image retention, rehydration, and no ref revival. Usage fixtures cover
OpenAI cache/image estimates, Anthropic cache/image estimates, and Gemini
text/image/cache modality details.

## Sources supplied with the research

1. [OpenClaw Browser control API](https://docs.openclaw.ai/tools/browser-control)
2. [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)
3. [OpenClaw Token use and costs](https://docs.openclaw.ai/reference/token-use)
4. [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
5. [OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
6. [Claude Vision](https://platform.claude.com/docs/en/build-with-claude/vision)
7. [Claude Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
8. [Gemini generate-content API](https://ai.google.dev/api/generate-content)
9. [OpenClaw Session pruning](https://docs.openclaw.ai/concepts/session-pruning)
