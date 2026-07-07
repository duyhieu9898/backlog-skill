# US-008 Overview

## Current Behavior

The Bemo skill can sync attendance/time-off data and can create every record in
`data/action-needed.json`. The Telegram agent can run fixed allowlisted
commands, but it cannot select dates to skip or bind a confirmation to the
filtered set of records.

## Target Behavior

The operator exposes a read-only late-list command and a typed create-preview
flow. A user may name dates to skip; the preview shows skipped and create dates,
and confirmation executes only the immutable selected plan.

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
