# Design

## Domain Model

`DesktopCapability`, `DesktopPermission`, `DisplayInfo`, and `AppDefinition`
are typed values. App definitions use reviewed IDs and fixed launch plans.
This story also defines the shared desktop event envelope, artifact metadata
contract, and presenter response reference used by US-014 through US-017.

## Application Flow

Router asks a desktop adapter for capability status; policy evaluates typed
actions before any platform call. Risky desktop actions create the existing
digest-bound pending confirmation; no desktop-specific confirmation table is
allowed.

## Observability

Use the existing trace event repository with the E02 envelope. Raw provider
payloads remain in the existing independent AI JSONL store; desktop code must
not create another raw request/response log format.
