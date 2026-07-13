# US-020 Browser Runtime and Lifecycle

## Status

implemented

## Lane

normal

## Product Contract

The agent exposes a single `browser` tool that manages the Chromium lifecycle, opens URLs, isolates contexts by profile, maintains active tabs mapped to stable internal IDs, and captures screenshots as platform artifacts.

## Relevant Product Docs

- `docs/stories/epics/E03-browser-capability/README.md`

## Acceptance Criteria

- Playwright and Chromium are installed as agent dependencies (`playwright` in `package.json`).
- Exposes a typed tool contract named `browser` in the tool executor, supporting `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`, `navigate`, and `screenshot`.
- Launches a managed Chromium instance using Playwright.
- Does not expose raw CDP or Playwright page instances directly. All pages are mapped to internal stable IDs (`tab_01`, `tab_02`, etc.) via a `TabRegistry`.
- Screenshots are saved to `ArtifactStore` and return a unique `artifactId`.

## Design Notes

- **New files:**
  - `agent/src/browser/browser-service.ts` (Interface and tab registry typings)
  - `agent/src/browser/managed-playwright-service.ts` (Playwright launch and tab controls implementation)
  - `agent/src/browser/profile-manager.ts` (Profile and userDataDir path resolver)
  - `agent/src/browser/tab-registry.ts` (Registry maps Playwright `Page` to `tab_xx`)
- **Modified files:**
  - `agent/src/tools/contracts.ts` (Define `BrowserToolAction` and update `ToolAction` union type)
  - `agent/src/tools/executor.ts` (Register `browser` schema, prepare, and execute blocks)
  - `agent/package.json` (Add `playwright` dependency)

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Validation of tool arguments against the `browser` schema. |
| Integration | Launch Chromium, open three tabs, verify they map to `tab_01`, `tab_02`, `tab_03` and can navigate independently. |
| E2E | Send a prompt to open a local test page, and verify a screenshot artifact is generated and saved. |
| Platform | Clean shutdown of Playwright browser processes when stopping. |

## Harness Delta

- Registry: `google-chrome-headless` capability is already present on the system and can be verified.
- Register `browser` tool in the tool runner database.

## Evidence

None.
