# Backlog Skill

Local Backlog API helpers for configured projects. The scripts use `BACKLOG_API_KEY` from `.env` and keep runtime choices separate from project metadata.

## Structure

```text
config/backlog.json        # shared runtime config
config/projects/OOP.json   # project catalog from Backlog API
config/projects/AQM.json   # project catalog from Backlog API
config/workflows/*.json    # personal workflow defaults
backlog_tool/settings.py
backlog_tool/client.py
backlog_tool/resolver.py
backlog_tool/issue_service.py
workflows/ut_bug.py
workflows/resolve_bug.py
workflows/story_task_overview.py
workflows/bug_template.py
scripts/backlog_config.py
scripts/inspect_project.py
scripts/backlog_api.py
scripts/create_ut_bug_default.py
scripts/bug_workflow.py
scripts/story_task_overview.py
docs/business_logic.md
docs/bug_workflow.md
docs/bug_field_guidance.md
```

`backlog.json` stores project keys, default project, and user refs. Project catalog files store API metadata such as project id, issue types, statuses, categories, and custom fields. Workflow config files store personal business defaults by label.

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

Commands use `default_project_key` from `config/backlog.json` unless `--project` is provided.

List/search:

```bash
python3 scripts/backlog_api.py get OOP-123
python3 scripts/backlog_api.py list
python3 scripts/backlog_api.py list --me
python3 scripts/backlog_api.py list --query keyword
python3 scripts/backlog_api.py list --project OOP --query keyword
```

Create:

```bash
python3 scripts/backlog_api.py create "Summary" --desc "Description" --issue-type Bug --dry-run
python3 scripts/backlog_api.py create "Summary" --project OOP --issue-type Bug --category 112_DHP --dry-run
python3 scripts/backlog_api.py create "Summary" --issue-type Bug --category 112_DHP --custom qc_activity="Unit Test" --dry-run
```

Update:

```bash
python3 scripts/backlog_api.py update OOP-123 --summary "New summary" --dry-run
python3 scripts/backlog_api.py update OOP-123 --project OOP --summary "New summary" --dry-run
python3 scripts/backlog_api.py update OOP-123 --status "In Progress" --comment "Updated by agent" --dry-run
python3 scripts/backlog_api.py update OOP-123 --custom impacted=no --dry-run
```

Remove `--dry-run` to call the write API.

## Default UT Bug Workflow

See `docs/business_logic.md` for personal UT bug defaults and field rules.

```bash
python3 scripts/create_ut_bug_default.py OOP-123 "A020100|FE" "Issue description"
python3 scripts/create_ut_bug_default.py --project OOP --dry-run OOP-123 "A020100|FE" "Issue description"
```

This creates a child bug using defaults from `config/workflows/ut_bug.json`, resolving labels to API IDs using the current project catalog. UT bug category is project-specific and comes from `project_overrides`; UT bug status defaults to `Closed`. Backlog create issue does not accept `statusId`, so the workflow creates the issue first and then updates the created issue to `Closed`.

## Personal Bug Workflow

See `docs/business_logic.md`, `docs/bug_workflow.md`, and `docs/bug_field_guidance.md` for detailed bug-fixing and resolve-field selection rules.

```bash
python3 scripts/bug_workflow.py my-open --project AQM
python3 scripts/bug_workflow.py context AQM-123
python3 scripts/bug_workflow.py resolve AQM-123 --actual-hours 1.5 --fix-description "Save issue" --comment "Fixed save issue"
python3 scripts/bug_workflow.py resolve AQM-123 --actual-hours 1.5 --apply
```

`resolve` is dry-run by default. It prepares a personal resolved-bug update: status, assignee back to creator, missing start date, missing due date as start date + 2 days, hours, and default bug custom fields. In this workflow, `impacted` and `corrective_action` are always overwritten; other custom fields are only set when currently empty.

Story/Task overview:

```bash
python3 scripts/story_task_overview.py --project AQM
```

Story/Task overview includes `issueKey`, `summary`, `description`, `status`, `dueDate`, `daysUntilDue`, and `dueAlertLevel`. Alert level `1` means overdue; alert level `2` means less than 2 days remain. Issues without `dueDate` are not warned.

## Safety

Use `--dry-run` before writes. Do not commit `.env` or print `BACKLOG_API_KEY`.

## Runtime Logs

Scripts write debug logs to `logs/backlog.log`. Logs include timestamp, command, project, dry-run flag, API method/path/status, and truncated API error bodies. They do not include `BACKLOG_API_KEY` or full URLs with query strings.

## Tests

Run the local test suite without calling Backlog. Some tests use committed fixtures captured from real Backlog API responses.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
```
