# Validation

## Proof Strategy

Prove the adapter contract deterministically, then prove the deployed UI flow
with a human-visible VS Code target. A successful input syscall alone is not
evidence of completion.

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | Existing-window focus does not invoke launch; absent app launches once; stale target/frame and mismatched target are rejected; CDP selection allows only configured loopback endpoints; repeated no-progress reaches early stop. |
| Integration | Fake OS and CDP adapters return target/frame/snapshot lifecycles; key/type actions bind to target; CDP ref actions use snapshot-scoped refs; receipts distinguish injection from verified postcondition. |
| E2E | With an existing VS Code window, close the named active tab and prove its absence; launch/focus VS Code, create a file, type `abc`, and prove visible editor content. Where a preconfigured CDP endpoint is available, prove a renderer interaction by ref and an explicit fallback for native UI. |
| Platform | Deployed local window manager reports whether it focused or launched; no duplicate VS Code window for the existing-window scenario; CDP never connects outside its configured loopback endpoint. |
| Performance | Repetition guard stops before eight calls when state/action fingerprint does not advance. |
| Logs/Audit | Trace contains sanitized target lifecycle and postcondition outcome; raw screen stays only in retained artifact storage. |

## Fixtures

- A configured Visual Studio Code desktop app.
- A disposable workspace and known open tab for close verification.
- A fake desktop adapter with deterministic focus, launch, frame, and visual
  predicate responses.
- A provider fixture that attempts repeated `launch` after a successful focus.
- A fake CDP endpoint plus a rejected remote/unconfigured endpoint fixture.

## Commands

Add exact commands after implementation.

```text
TBD
```

## Acceptance Evidence

Planned. Baseline traces are `tr_mrophd6v_684f374e`,
`tr_mropjg0r_1250ddd1`, and `tr_mropq2ar_1203a5aa`.
