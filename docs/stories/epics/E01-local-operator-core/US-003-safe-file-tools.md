# US-003 Safe File Tools

## Status

planned

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

No implementation proof yet.
