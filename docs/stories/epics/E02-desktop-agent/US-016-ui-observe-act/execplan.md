# Exec Plan

## Goal

Add reliable bounded UI interaction on top of the US-015 vertical slice.

## Risk Classification

Risk flags: authorization, audit/security, public workflow, existing behavior.

## Work Phases

1. Ensure the reviewed Linux/X11 adapter prerequisites are installed through
   `agent/scripts/my-agent desktop-deps`.
2. Define platform-neutral UI snapshot and target contracts using the
   OpenClaw computer-control pattern: actions bind to the observed frame and
   fail closed after target or display changes.
3. Implement fake adapter and stale-plan rejection.
4. Add one harmless real-app proof after confirmation.

## Stop Conditions

Pause if a platform exposes only coordinates without stable target identity.
