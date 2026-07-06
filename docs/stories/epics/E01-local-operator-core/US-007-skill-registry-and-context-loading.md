# US-007 Skill Registry And Context Loading

## Status

implemented

## Lane

normal

## Product Contract

The agent discovers local skills from `skills/*/SKILL.md`, exposes their
metadata, and loads full skill instructions only when relevant to the request.

## Relevant Product Docs

- `skills.md`
- `plan.md`
- `docs/stories/epics/E01-local-operator-core/README.md`

## Acceptance Criteria

- Skill registry scans `../skills/*/SKILL.md` from the `agent` directory.
- Skill slug is the folder name.
- Frontmatter `description` is required.
- Metadata includes slug, name, description, baseDir, and skillPath.
- Full `SKILL.md` content is loaded only for selected skills.
- `/skills` displays discovered skill metadata.
- Registry errors are visible in `/status` or `/last-error`.

## Design Notes

- Modules:
  - `agent/src/skills/SkillRegistry.ts`
- Domain rules:
  - Skill implementations remain outside `agent/src/`.
  - Skill commands are still controlled by command allowlist.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Frontmatter parsing, missing description rejection, slug derivation. |
| Integration | Registry scans fixture skills and current repo skills. |
| E2E | `/skills` shows Bemo, Gmail, and Linux janitor when present. |
| Platform | Relative paths resolve under service runtime. |
| Release | `skills.md` and README stay aligned with actual behavior. |

## Harness Delta

None expected.

## Evidence

- Existing implementation:
  - `agent/src/skills/registry.ts` scans local skills and loads skill metadata.
  - `agent/src/context/hydrator.ts` includes skill metadata, recent chat,
    allowed commands, selected skill content, recent runs, and trace events.
  - `/skills` uses the registry to display discovered skills.
- Validation:
  - `npm test` in `agent/` passed 38/38 on 2026-07-06.
  - Unit coverage verifies frontmatter validation, slug derivation, deterministic
    matching, ambiguous-match refusal, `{baseDir}` expansion, and byte-budget
    truncation.
  - Integration coverage scans the current Bemo, Gmail, and Linux Janitor
    skills while retaining valid skills when another package is invalid.
  - Context hydration proof loads full Bemo instructions for a selected request
    and leaves them absent for a general request.
  - Path-independence proof creates the default registry from a child process whose
    cwd is outside `agent/` and still resolves all repository skills.
  - After deploying commit `8fce060`, the installed systemd user service rebuilt
    and entered Telegram polling successfully.
  - The user confirmed successful human-authored `/skills` and `/status` smoke
    responses on 2026-07-06, covering the three loaded skills, registry status,
    Telegram routing, and installed-service runtime.
- Completed behavior:
  - Registry errors no longer prevent startup and are visible in `/status` and
    `/skills`.
  - Matching prioritizes exact slug/name phrases, scores meaningful metadata
    tokens, and refuses tied results instead of choosing by directory order.
  - Selected skill content expands `{baseDir}` references and uses UTF-8-safe
    truncation.
- Gaps:
  - None for the US-007 contract.
