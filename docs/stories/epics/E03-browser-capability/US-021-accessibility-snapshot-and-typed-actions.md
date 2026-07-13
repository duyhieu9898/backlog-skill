# US-021 Accessibility Snapshot and Typed Actions

## Status

planned

## Lane

normal

## Product Contract

The agent does not inspect raw HTML. It requests a simplified text-based accessibility tree snapshot of the page. Interactive elements are assigned unique reference IDs (refs), which are used for typed actions (click, fill, type, press, select, scroll, wait). The system ensures that refs are not stale, but attempts a fallback resolution using element descriptors if the DOM changes slightly.

## Relevant Product Docs

- `docs/stories/epics/E03-browser-capability/README.md`

## Acceptance Criteria

- Binds the `snapshot` action to return a text representation of the page structure (e.g. `button "Đăng nhập" [ref=e1]`).
- Supports the `act` action to perform `click`, `fill`, `type`, `press`, `select`, `scroll`, and `wait`.
- Maps each ref to a Playwright `LocatorDescriptor` (e.g. `{ role: "button", name: "Đăng nhập" }`) in a temporary `RefStore` scoped to the current `snapshotId` and `targetId`.
- Validates refs against `snapshotId` before executing.
- **Fallback Resolution:** If the snapshot is stale (the page DOM has updated, or the snapshotId is old), the `ActionExecutor` first attempts to re-locate the element on the live page using the stored `LocatorDescriptor`. If a single unique element matches, the action is executed. If multiple or zero elements match, a structured `STALE_ELEMENT_REF` or `ELEMENT_NOT_FOUND` error is returned.

## Design Notes

- **New files:**
  - `agent/src/browser/snapshot-service.ts` (HTML to accessibility text rendering)
  - `agent/src/browser/ref-store.ts` (Store snapshot refs and descriptor maps)
  - `agent/src/browser/action-executor.ts` (Resolve locators and execute Playwright actions)
  - `agent/src/browser/errors.ts` (Browser structured error classes and codes)

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Tests for accessibility tree parsing and ref-to-descriptor mapping. |
| Integration | Generate snapshot on a local test page, execute actions by ref, and verify locator resolution. |
| E2E | Run a click and input flow using refs on a local form. |

## Harness Delta

- None.

## Evidence

None.
