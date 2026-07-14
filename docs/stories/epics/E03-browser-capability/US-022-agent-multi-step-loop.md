# US-022 Agent Multi-Step Loop

## Status

completed

## Lane

normal

## Product Contract

The agent orchestrator loop supports executing multiple tool steps consecutively. The browser visual artifacts (screenshots) are correctly parsed and fed back into the AI provider's context for subsequent steps. The system handles transient stale reference errors by retrying once, and includes a structured skill instruction package (`skills/browser/`) to guide the model's browser workflows.

## Relevant Product Docs

- `docs/stories/epics/E03-browser-capability/README.md`

## Acceptance Criteria

- Updates the tool loop in `agent/src/tools/loop.ts` to support browser-specific tool result codes (`BROWSER_SCREENSHOT`, `BROWSER_ACTION_COMPLETED`, etc.) when extracting artifact IDs and generating base64 visual contexts for the AI model (`modelImageForResult`).
- The agent loop can coordinate up to 8 consecutive tool execution steps per request.
- **Retry Policy:** If a browser action fails due to a retryable `STALE_ELEMENT_REF` error, the loop automatically schedules a new `snapshot` step, resolves the new reference, and retries the target action exactly once before returning a failure to the user.
- Emplaces the browser skill under `skills/browser/SKILL.md` (detailing workflow steps, snapshot usage rules, and safety bounds) and supporting references under `skills/browser/references/`.

## Design Notes

- **Modified files:**
  - `agent/src/tools/loop.ts` (Extend code check list for screenshot attachments; add auto-retry loop for stale refs)
- **New files:**
  - `skills/browser/SKILL.md` (AI instruction manual for browser capability)
  - `skills/browser/references/workflow.md` (Standard browser trajectory guide)
  - `skills/browser/references/safety.md` (Rules for consequential actions)
  - `skills/browser/references/errors.md` (Error remediation instructions)

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Verify `SKILL.md` matches frontmatter schema and registers in SkillRegistry. |
| Integration | Verify that multiple tool calls are compiled and executed sequentially in tests. |
| E2E | Send the prompt: "Mở trang test, chụp ảnh và gửi cho tôi" and verify the agent loop runs `browser.open`, `browser.screenshot`, and returns the screenshot in a single turn. |

## Harness Delta

- None.

## Evidence

None.
