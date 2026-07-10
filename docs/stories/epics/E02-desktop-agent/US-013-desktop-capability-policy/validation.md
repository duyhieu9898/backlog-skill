# Validation

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | Capability parsing, absent adapter, permission denial, app ID validation, shared event envelope. |
| Integration | Fake adapter advertises displays, rejects undeclared actions, and reuses pending confirmation. |
| Platform | Local adapter reports actual permission state without acting. |

## Acceptance Evidence

- 2026-07-10: `scripts/bin/harness-cli query tools --capability desktop --status present`
  returned no equipped desktop capability, so the runtime reports all desktop
  capabilities as unavailable and performs no platform action.
- 2026-07-10: `cd agent && npm run verify` passed 61/61 tests. Coverage proves
  app ID validation, unavailable/denied desktop policy outcomes,
  digest-confirmation gating, shared `desktop.*` trace events, and `/desktop`
  status output.
