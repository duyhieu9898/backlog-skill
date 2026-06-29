# US-007 Skill Registry And Context Loading

## Status

in_progress

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
  - `npm test` in `agent/` passed on 2026-06-26 with tests for context budget
    truncation and rejection of skills missing `description`.
- Gaps:
  - Registry error surfacing in `/status` or `/last-error` is not complete.
  - Skill matching is still simple keyword matching.
  - Current repo has no active `skills/backlog/SKILL.md`, while
    `agent/commands.json` still contains backlog commands.
