# Validation

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | State transitions, expiry, duplicate action, and retry stop rules. |
| Integration | Resume matching state; reject changed state and expired artifact. |
| E2E | Human prompt-trial checklist for capture, launch, refusal, and recovery. |
| Logs/Audit | Agent can find a failing trace via compact index without reading all raw logs. |

## Acceptance Evidence

TBD
