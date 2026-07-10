# Design

## Application Flow

`screen.capture` and `app.launch` are typed tools backed by the desktop
adapter. Both create exact previews; policy decides whether the action needs
confirmation. Capture returns an artifact; launch verifies a process/window
signal before reporting success. The tools reuse the US-013 policy/event
contracts, US-014 artifact/delivery envelope, and existing pending
confirmation store.

## Interface Contract

`screen.capture({ display?: number })` and `app.launch({ appId })` accept no
raw paths. Tool results are structured and presenter-aware.

## UI / Platform Impact

Adapters may differ by Linux, Windows, and macOS, but each must advertise
availability rather than guessing commands. US-015 proves one reviewed Linux
adapter only; other platforms remain capability-compatible follow-up adapters.
