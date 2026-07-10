# Validation

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | Tool schemas, confirmation policy, app ID allowlist, unavailable display. |
| Integration | Fake capture produces artifact; fake launch proves exact app plan. |
| E2E | Authorized Telegram prompt receives a test screenshot artifact. |
| Platform | Local permission-denied and successful capture/launch smoke. |
| Logs/Audit | Common desktop trace joins tool call, artifact ID, Telegram delivery, and cleanup; raw provider JSONL is queried through its existing index. |

## Acceptance Evidence

TBD
