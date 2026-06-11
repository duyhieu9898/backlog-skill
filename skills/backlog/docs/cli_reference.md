# CLI Reference

Entry point: `python3 scripts/backlog.py` (chạy từ `skills/backlog/`).

## Config

```bash
python3 scripts/backlog.py config list-projects
python3 scripts/backlog.py config current
python3 scripts/backlog.py config set-default AQM
python3 scripts/backlog.py config show
```

`set-default` chỉ nhận key đã có trong `config/backlog.json`.

## Project Inspect

```bash
python3 scripts/backlog.py project inspect AQM
python3 scripts/backlog.py project inspect OOP --stdout
```

Ghi đè `config/projects/<KEY>.json`. Output là catalog từ API, không chứa runtime choices.

## Issue

```bash
python3 scripts/backlog.py issue get OOP-123
python3 scripts/backlog.py issue list [--query keyword] [--project OOP] [--all]
python3 scripts/backlog.py issue list --type Bug --view bug
python3 scripts/backlog.py issue list --type Story --type Task --view story
```

Create (dry-run mặc định):

```bash
python3 scripts/backlog.py issue create "Summary" --issue-type Bug [--desc "..."] [--category ...] [--custom key=value] [--apply]
```

Update (dry-run mặc định):

```bash
python3 scripts/backlog.py issue update OOP-123 [--summary "..."] [--status "..."] [--comment "..."] [--custom key=value] [--apply]
```

Flags chung cho create/update: `--project`, `--desc`, `--priority`, `--assignee`, `--category`, `--start-date`, `--due-date`, `--estimated-hours`, `--actual-hours`, `--custom KEY=VALUE` (repeatable).

## Bug Workflow

```bash
python3 scripts/backlog.py bug my-open [--project AQM] [--query keyword]
python3 scripts/backlog.py bug context AQM-123
python3 scripts/backlog.py bug rules
python3 scripts/backlog.py bug fields [<field>]
python3 scripts/backlog.py bug resolve AQM-123 [--actual-hours 1.5] [--fix-description "..."] [--comment "..."] [--apply]
python3 scripts/backlog.py bug create-ut OOP-123 "A020100|FE" "description" [--project OOP] [--apply]
```

## Story/Task Overview

```bash
python3 scripts/backlog.py story overview [--project AQM] [--query keyword]
```

## Metrics & Journal

```bash
python3 scripts/backlog.py metrics summary
python3 scripts/backlog.py journal list
python3 scripts/backlog.py journal read <filename>
python3 scripts/backlog.py journal log-ai --command "bug:my-open" --stdin [--issue-key "AQM-123"]
```
