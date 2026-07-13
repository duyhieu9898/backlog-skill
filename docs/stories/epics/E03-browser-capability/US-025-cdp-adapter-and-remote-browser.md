# US-025 CDP Adapter and Remote Browser

## Status

planned

## Lane

normal

## Product Contract

The agent can control an external running browser or remote Chromium instance by attaching through the Chrome DevTools Protocol (CDP). The CDP mode profiles share the exact same tool and registry contracts, making connection modes transparent to the orchestrator loop and the AI model.

## Relevant Product Docs

- `docs/stories/epics/E03-browser-capability/README.md`

## Acceptance Criteria

- Supports profile configuration modes: `managed` (local Playwright launch) and `cdp` (attach to remote browser).
- Reads CDP endpoints (e.g. `http://127.0.0.1:9222` or a WebSocket address) from `agent/config.json`.
- Implements `CdpBrowserService` using Playwright's `chromium.connectOverCDP()`.
- Successfully integrates the connected browser pages into the existing `TabRegistry` and `ActionExecutor` workflows.

## Design Notes

- **New files:**
  - `agent/src/browser/cdp-browser-service.ts` (CDP protocol adapter)
- **Modified files:**
  - `agent/src/browser/browser-service.ts` (Add factory to initialize `CdpBrowserService` or `ManagedPlaywrightBrowserService` based on profile mode)

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Verify profile config endpoint validation. |
| Integration | Start a separate Chromium process with `--remote-debugging-port=9222`, connect the agent over CDP, and assert successful page count and titles. |
| E2E | Attach to a local debugging Chrome browser and perform a query check workflow. |

## Harness Delta

- Add CDP profile examples in app configuration.

## Evidence

None.
