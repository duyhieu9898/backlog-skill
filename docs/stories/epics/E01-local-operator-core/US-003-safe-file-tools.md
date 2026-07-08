# US-003 Safe File Tools

## Status

in_progress

## Lane

high-risk

## Product Contract

The agent exposes minimal filesystem tools that can read, list, create, write,
and patch allowed files while refusing denied paths and risky operations.

## Relevant Product Docs

- `plan.md`
- `docs/stories/epics/E01-local-operator-core/README.md`
- `docs/stories/epics/E01-local-operator-core/US-002-permission-policy-for-local-tools.md`

## Acceptance Criteria

- Tools exist for `file.read`, `file.list`, `file.exists`, `file.mkdir`,
  `file.write`, and `file.patch`.
- Writes and patches require policy approval.
- Large reads are truncated with an explicit marker.
- Patch previews can be generated before applying changes.
- File tool results are structured JSON, not only free-form text.
- File operations are recorded in trace events.

## Design Notes

- Commands:
  - Internal tool API only at first.
- Domain rules:
  - Prefer patch over overwrite for existing text files.
  - Refuse binary writes until a real use case exists.
  - `delete` is excluded from the first version or requires confirmation.

## Implementation Design

- `agent/src/tools/contracts.ts` defines the six file action schemas and
  structured `ToolResult` contract.
- `agent/src/tools/files.ts` owns policy evaluation, preview generation, text
  validation, bounded reads/lists, atomic writes, exact-match patches, and
  content-free trace events.
- Read/list/exists actions execute after an `allow` decision.
- Mkdir/write/patch return `CONFIRMATION_REQUIRED` plus a structured preview;
  execution requires `confirmationGranted` from a trusted caller.
- AI and Telegram routing remain out of scope until US-009; exact confirmation
  binding remains in US-005.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Path checks, truncation, write refusal, patch validation. |
| Integration | Temp workspace read/write/patch/list tests. |
| E2E | Telegram request can create an allowed note file after confirmation if configured. |
| Platform | Works under systemd service cwd. |
| Release | Tool schemas documented for AI routing. |

## Harness Delta

High-risk because file write capability can change local state.

## Evidence

Implementation slice completed on 2026-07-03:

- All six internal file tools are implemented and call `PermissionPolicy`
  before I/O.
- Reads truncate explicitly; denied directory children are hidden; binary
  reads/writes and ambiguous patches are refused.
- Mutations provide previews and do not change state without confirmation.
- File results and denials are recorded in trace events without file content.
- `cd agent && npm test` passed 18/18 tests.
- Decision recorded in `docs/decisions/0009-safe-file-tool-semantics.md`.

Remaining proof before completion:

- Telegram/provider E2E after US-009 exposes validated file actions.
- Installed systemd service cwd/path smoke proof for a non-mutating file action.
