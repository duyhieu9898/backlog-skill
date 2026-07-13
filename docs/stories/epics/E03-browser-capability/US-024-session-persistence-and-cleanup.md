# US-024 Session Persistence and Cleanup

## Status

planned

## Lane

high-risk

## Product Contract

The agent's browser capability supports isolated profiles to preserve cookies and login states across restarts. It also implements resource management sweepers to prevent memory leaks and zombie Chromium processes.

## Relevant Product Docs

- `docs/stories/epics/E03-browser-capability/README.md`

## Acceptance Criteria

- **Context Isolation:** Profiles are stored under distinct directory paths (`~/.my-agent/browser/profiles/<profile_name>`) and do not share state.
- **Session Persistence:** Persistent context mode preserves session cookies, cache, and localStorage according to profile configuration.
- **Idle Sweeper:** A periodic background cleanup routine runs every 5 minutes (`cleanup-sweeper.ts`). It closes tabs that have been idle for more than 30 minutes, caps active tabs at 10 per profile (closing the oldest first), and deletes expired snapshot records.
- **Process Lifecycle:** Listens to `SIGTERM` and `SIGINT` inside `agent/src/bot.ts` to execute a synchronous or graceful shutdown of all Playwright/Chromium instances.

## Design Notes

- **New files:**
  - `agent/src/browser/cleanup-sweeper.ts` (Resource limits sweeper)
- **Modified files:**
  - `agent/src/browser/browser-service.ts` (Expose `shutdown()` capability)
  - `agent/src/bot.ts` (Wire process exit listeners to `BrowserService.shutdown()`)
  - `agent/config.json` (Add browser quota settings: `idleMinutes`, `maxTabsPerProfile`, `snapshotTtlMinutes`)

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Test that idle tab sweep logic correctly identifies and closes stale tabs. |
| Integration | Save a session cookie in one profile context, restart, and assert that the cookie is still present in the next instance. |
| E2E | Run the agent service, initiate browser activity, then send a SIGTERM signal to the process and verify no Chromium zombie processes remain. |

## Harness Delta

- Add browser resource settings to app config.

## Evidence

None.
