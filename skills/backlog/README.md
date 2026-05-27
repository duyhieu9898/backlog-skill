# Backlog Skill

Local Backlog API helpers for configured projects. The scripts use `BACKLOG_API_KEY` from `.env` and keep runtime choices separate from project metadata.

## Structure

```text
config/backlog.json        # shared runtime config
config/OOP.json            # project catalog from Backlog API
config/AQM.json            # project catalog from Backlog API
scripts/backlog_settings.py
scripts/backlog_config.py
scripts/inspect_project.py
scripts/backlog_api.py
scripts/create_ut_bug_default.py
```

`backlog.json` stores project keys, default project, user refs, and default choices by label. Project catalog files store API metadata such as project id, issue types, categories, and custom fields.

## Setup

Create `.env`:

```env
BACKLOG_API_KEY=your-api-key
```

Refresh project catalogs:

```bash
python3 scripts/inspect_project.py OOP
python3 scripts/inspect_project.py AQM
```

## Config

Show configured projects:

```bash
python3 scripts/backlog_config.py list-projects
```

Show current default:

```bash
python3 scripts/backlog_config.py current
```

Set default project:

```bash
python3 scripts/backlog_config.py set-default AQM
```

## Generic Issue CLI

All commands use `default_project_key` from `config/backlog.json`.

List/search:

```bash
python3 scripts/backlog_api.py list
python3 scripts/backlog_api.py list --me
python3 scripts/backlog_api.py list --query keyword
```

Create:

```bash
python3 scripts/backlog_api.py create "Summary" --desc "Description" --issue-type Bug --dry-run
python3 scripts/backlog_api.py create "Summary" --category 112_DHP --custom qc_activity="Unit Test" --dry-run
```

Update:

```bash
python3 scripts/backlog_api.py update OOP-123 --summary "New summary" --dry-run
python3 scripts/backlog_api.py update OOP-123 --status "In Progress" --comment "Updated by agent" --dry-run
python3 scripts/backlog_api.py update OOP-123 --custom impacted=no --dry-run
```

Remove `--dry-run` to call the write API.

## Default UT Bug Workflow

```bash
python3 scripts/create_ut_bug_default.py OOP-123 "A020100|FE" "Issue description"
```

This creates a child bug using defaults from `backlog.json`, resolving labels to API IDs using the current project catalog.

## Safety

Use `--dry-run` before writes. Do not commit `.env` or print `BACKLOG_API_KEY`.
