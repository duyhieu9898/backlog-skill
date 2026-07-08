# US-008 Overview

## Current Behavior

The Bemo skill can sync attendance/time-off data, list late-day candidates,
prepare a digest-bound selected-record plan with skipped dates, and execute the
selected create plan through JSON stdin after confirmation. The Telegram agent
can run fixed allowlisted commands and the generic AI tool loop can compose a
read-only prepare step into a confirmed create preview.

## Remaining Target Behavior

The deployed operator still needs human Telegram smoke showing `/bemo_late` and
a natural-language create preview through the configured provider without
confirming a real write. Successful provider-write proof is deliberately
separate and requires explicit approval.

## Affected Users

- The single allowlisted Telegram operator.

## Affected Product Docs

- `skills/bemo/SKILL.md`
- `skills/bemo/README.md`
- `agent/README.md`

## Non-Goals

- No AI-selected external writes in this story.
- No automatic scheduling.
- No change to Bemo login/session ownership.
- No real time-off creation during automated tests.
