# E03 Browser Capability

> Migration notice (2026-07-14): Browser policy uses the trusted-local model
> in ADR 0017. Routine navigation and UI steps are default-allow; approval is
> scoped to significant new external effects or sensitive/high-impact actions,
> not individual clicks.
>
> Migration notice (2026-07-17, P2.5): Network restrictions are **guardrails**,
> not an inherited sandbox boundary. Private/localhost navigation is governed by
> owner posture (`permissions.browser.privateNavigation`, default `allow`) so the
> owner's agent can reach the router, dev servers, and intranet. Only protocol
> escapes and SSRF/non-routable destinations (cloud metadata `169.254.169.254`,
> link-local, unspecified, multicast/reserved) remain hard-denied. See US-023.

## Goal

Provide a robust, multi-step browser automation capability matching the OpenClaw architecture: the skill guides the model, the browser tool provides a typed action contract, the browser service manages Playwright/Chromium instances, and the orchestrator loop manages multi-step execution.

## Scope Boundary

The browser agent does not gain arbitrary JavaScript execution authority or raw CDP capabilities in the first version. All interactions are typed (click, fill, type, press, select, scroll, wait) and validated against a target URL and accessible element name.

## Shared Contracts

All browser activities are policy-gated and reuse the following existing agent contracts:

| Concern | Shared owner and rule |
| --- | --- |
| Authority | `PermissionPolicy` remains the sole boundary for authorizing actions and requesting human confirmation. |
| Approval | Reuse `ApprovalService` and persisted scoped approvals; no browser-specific approval tables or mechanisms. |
| Trace | Every browser tool call propagates the active `traceId` and logs structured trace events. |
| Artifacts | Screenshots are saved as local images in `ArtifactStore`; SQLite persists metadata and delivery details. |
| Loop Integration | The agent loop in `loop.ts` is updated to handle browser-specific codes to render and feed screenshots back to the AI. |

## Recommended Order

| Story | Outcome | Depends On |
| --- | --- | --- |
| US-020 | Browser Runtime and Lifecycle | E01/E02 core, Playwright install |
| US-021 | Accessibility Snapshot and Typed Actions | US-020 |
| US-022 | Agent Multi-Step Loop and Browser Skill | US-021 |
| US-023 | Browser Safety and Network Policy | US-021, US-022 |
| US-024 | Session Persistence and Cleanup | US-020, US-023 |
| US-025 | CDP Adapter and Remote Browser | US-020, US-024 |

## Validation Strategy

- **Unit tests** cover schema validation, URL blocklist/allowlist parsing, ref mapping, and stale ref locator fallbacks.
- **Integration tests** cover Playwright startup/shutdown, tab state tracking, and HTML-to-accessibility-tree generation.
- **Manual smoke tests** exercise the Telegram `/bemo_late` equivalent for browser prompts (e.g. navigation and click/fill flows).
