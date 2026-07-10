# Exec Plan

## Goal

Add reliable bounded UI interaction on top of the US-015 vertical slice.

## Risk Classification

Risk flags: authorization, audit/security, public workflow, existing behavior.

## Work Phases

1. Define platform-neutral UI snapshot and target contracts.
2. Implement fake adapter and stale-plan rejection.
3. Add one harmless real-app proof after confirmation.

## Stop Conditions

Pause if a platform exposes only coordinates without stable target identity.
