# Command Naming

This document records the naming convention for optional command shortcuts in
`agent/commands.json`. They improve discoverability and structured skill input;
they are not the primary permission boundary.

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

## Shortcut Notes

- Prefer fixed commands with an exact `argv` array. `command.run` also supports
  owner-relevant arbitrary argv and, where required, a shell command.
- Every invocation crosses `ToolGateway`; policy evaluates the actual command,
  arguments, cwd, target, intent, approval, and impact instead of shortcut
  membership alone.
- Skill commands must use a cwd matching their `skillSlug`; stale entries fail catalog loading.
- Shortcut metadata may communicate expected risk, but significant actions use
  scoped task approval and clearly destructive actions are denied.
- Configured schedules are pre-approved for their declared objective and still
  pass through the runtime gateway on each execution.
