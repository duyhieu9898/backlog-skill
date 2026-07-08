# Command Naming

This document records the command naming convention used by `agent/commands.json`.

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
- `bemo.late-list`
- `bemo.prepare-timeoff`
- `bemo.create-timeoff`
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

- Fixed commands use an exact `argv` array and run without a shell.
- Wildcard and model-provided raw-shell commands are unsupported.
- Skill commands must use a cwd matching their `skillSlug`; stale entries fail catalog loading.
- Commands that write external data or delete data set both
  `requiresConfirmation: true` and `externalSideEffect: true`.
- Commands referenced by `config.json` scheduled checks must be read-only:
  `requiresConfirmation: false` and `externalSideEffect: false`.
