# US-008 Validation

## Proof Strategy

Pure functions and fixture files prove date parsing, filtering, digest binding,
plan expiry, and selected-record execution. Generic tool-loop integration
proves the AI can compose a read-only prepare command into a confirmed create
preview without running the external write before confirmation. External proof
stops at a dry-run/read-only list unless the human separately approves a real
write.

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | Canonical dates, invalid/unknown skips, duplicates, filtering, digest, expiry, preview. |
| Integration | JSON-stdin prepare/create commands, pending tool confirmation, tamper refusal, fake create receives only selected records. |
| E2E | Telegram `/bemo_late` and natural-language create preview with no confirmation. |
| Platform | Installed service resolves Bemo data and keeps create behind confirmation. |
| Performance | Plan and preview stay bounded by action file/write limits. |
| Logs/Audit | Trace contains source timestamp, skipped/selected/created/failed dates and excludes secrets. |

## Fixtures

- Three deterministic late records on distinct dates.
- One skipped date and two selected dates.
- Missing, malformed, duplicate, expired, and digest-tampered plans.
- Fake create callback; no browser or Bemo endpoint.

## Commands

```text
cd agent && npm test
cd skills/bemo && npm test
scripts/bin/harness-cli story verify US-008
```

## Acceptance Evidence

- `cd agent && npm test`: 42/42 pass.
- `cd skills/bemo && npm test`: 6/6 pass.
- Read-only local Bemo smoke: current ignored `action-needed.json` parses with
  count=1 and skip-empty plan has createDates=1.
- Installed service restart/build/polling: pass.
- No provider write was executed.
- Human Telegram list/natural-language preview smoke remains pending.
