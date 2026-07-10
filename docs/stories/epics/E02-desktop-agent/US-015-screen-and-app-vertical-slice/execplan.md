# Exec Plan

## Goal

Deliver the first useful desktop-agent prompt slice: screenshot-send and
reviewed app launch.

## Risk Classification

Risk flags: authorization, audit/security, external system, existing behavior.

## Work Phases

1. Select one local platform adapter after capability discovery.
2. Implement typed capture and launch tools behind confirmation.
3. Connect artifacts to Telegram media delivery.
4. Run human prompts and inspect trace-partitioned raw logs.

## Stop Conditions

Pause if screen permission is not granted, a launch target is not reviewed, or
the output cannot be safely delivered only to the authorized chat.
