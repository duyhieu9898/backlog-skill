# Backlog Skill

Local Backlog API helpers for configured projects. Uses `BACKLOG_API_KEY` from `.env` and keeps runtime choices separate from project metadata. All commands run through one unified CLI: `scripts/backlog.py`.

## Structure

```text
config/backlog.json        # shared runtime config
config/projects/*.json     # project catalogs from Backlog API
config/workflows/*.json    # personal workflow defaults
backlog_tool/cli.py        # unified CLI: parser, dispatch, presenter, metrics
backlog_tool/presenter.py  # compact output shapes
backlog_tool/inspect.py    # build project catalog
backlog_tool/settings.py   # config, logging, metrics
backlog_tool/client.py
backlog_tool/resolver.py
backlog_tool/issue_service.py
workflows/*.py             # ut_bug, resolve_bug, story_task_overview, guidance, bug_template
scripts/backlog.py         # entry point
scripts/*.py               # legacy shims forwarding to scripts/backlog.py
docs/*.md
```

`backlog.json` stores project keys, default project, and user refs. Project catalog files store API metadata. Workflow config files store personal business defaults by label.

## Conventions

- Compact output by default; add global `--json-full` (before the group) for raw JSON.
- Write commands (`issue create/update`, `bug resolve`, `bug create-ut`) are dry-run by default; add `--apply` to write.
- Errors go to stderr. Every run is measured into `logs/metrics.log`.
- `--help` is available at every level: `backlog.py --help`, `backlog.py bug --help`.

## Setup

Create `.env`:

```env
BACKLOG_API_KEY=your-api-key
```

Refresh catalogs:

```bash
python3 scripts/backlog.py project inspect OOP
python3 scripts/backlog.py project inspect AQM
```

## Config

```bash
python3 scripts/backlog.py config list-projects
python3 scripts/backlog.py config current
python3 scripts/backlog.py config set-default AQM
```

## Issue

```bash
python3 scripts/backlog.py issue get OOP-123
python3 scripts/backlog.py issue list [--me] [--query keyword] [--project OOP]
python3 scripts/backlog.py issue create "Summary" --issue-type Bug [--apply]
python3 scripts/backlog.py issue update OOP-123 --status "In Progress" --comment "..." [--apply]
```

Create/update are dry-run until `--apply`.

## Default UT Bug Workflow

See `docs/business_logic.md` for personal UT bug defaults and field rules.

```bash
python3 scripts/backlog.py bug create-ut OOP-123 "A020100|FE" "Issue description" [--apply]
```

Creates a child bug using defaults from `config/workflows/ut_bug.json`, resolving labels to API IDs from the project catalog. UT bug category is project-specific (`project_overrides`); status defaults to `Closed`. Backlog create issue does not accept `statusId`, so the workflow creates the issue first then updates it to `Closed`.

## Personal Bug Workflow

Rules and field guidance are encoded in the CLI — run the commands instead of reading long docs:

```bash
python3 scripts/backlog.py bug rules
python3 scripts/backlog.py bug fields [<field>]
```

```bash
python3 scripts/backlog.py bug my-open --project AQM
python3 scripts/backlog.py bug context AQM-123
python3 scripts/backlog.py bug resolve AQM-123 --actual-hours 1.5 --fix-description "Save issue" [--apply]
```

`resolve` is dry-run by default and returns a `changes` diff plus `warnings`. It sets status, assignee back to creator, missing dates/hours, and default bug custom fields. `impacted` and `corrective_action` are always overwritten; other custom fields are set only when empty.

## Story/Task Overview

```bash
python3 scripts/backlog.py story overview --project AQM
```

Includes `issueKey`, `summary`, `description`, `status`, `dueDate`, `daysUntilDue`, `dueAlertLevel`. Alert level `1` = overdue; `2` = less than 2 days remain. Issues without `dueDate` are not warned.

## Metrics

```bash
python3 scripts/backlog.py metrics summary
```

Aggregates runs, total/average output bytes, and p95 latency per command from `logs/metrics.log`. Use it to measure the compact-output saving during live testing.

## Safety

Write commands are dry-run by default; review then add `--apply`. Do not commit `.env` or print `BACKLOG_API_KEY`.

## Tests

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
```
