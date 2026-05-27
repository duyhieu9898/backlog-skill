# Command Naming

This document records the command naming convention to use when `agent/commands.json` is refactored.

## Format

```text
<skillSlug>.<action>
```

Use lowercase words and underscores only when the action needs multiple words.

## Suggested Names

### Bemo

- `bemo.checkout`
- `bemo.sync`
- `bemo.verify`
- `bemo.run`
- `bemo.auth`

### Backlog

- `backlog.list`
- `backlog.search`
- `backlog.create`
- `backlog.update`
- `backlog.create_ut_bug_default`

### Gmail

- `gmail.search_unread`
- `gmail.delete_unread`
- `gmail.clear_unread`

### Linux Janitor

- `linux.health`
- `linux.processes`
- `linux.logs`
- `linux.all`

## Allowlist Notes

- Fixed commands should use exact command strings.
- Trusted self-authored skills may use `command: "*"` with a fixed `cwd`.
- Wildcard commands still need denylist validation.
- Commands that write external data or delete data should set `requiresConfirmation: true`.
