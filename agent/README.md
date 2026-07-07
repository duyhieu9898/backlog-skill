# Agent

Telegram command router for local agents in this `my-agents` folder.

## Run

```bash
npm install
npm start
```

`agent/.env` must define `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
`TELEGRAM_POLL_TIMEOUT` is optional and defaults to 25 seconds. Secrets and
chat identifiers must never have source-code fallbacks.

## Debug Commands

- `/status` — uptime, current command, pending confirmations, loaded commands,
  loaded skills, skill-registry errors, and SQLite path.
- `/last` — latest command result and output tail.
- `/last-error` — latest command or tool failure with trace ID.
- `/debug <traceId>` — trace events for one execution.
- `/commands` — allowlisted commands grouped by skill.
- `/skills` — loaded skill names and descriptions, plus any invalid skill
  metadata that was skipped during scanning.
- `/help` — command summary.

## Background CLI

Install the `my-agent` CLI and systemd user service:

```bash
./scripts/my-agent install
```

Make sure `~/.local/bin` is in your `PATH`, then control the background service:

```bash
my-agent start
my-agent stop
my-agent restart
my-agent status
my-agent logs
```

To keep the user service running after logout:

```bash
my-agent enable-login
```

The service uses `npm run start` in this `agent` directory and restarts automatically on failure.

## Bemo Late-Day Workflow

- `/bemo_sync` refreshes attendance/time-off source data.
- `/bemo_late` lists the current late-day candidates without writing to Bemo.
- Natural-language requests such as `tạo timeoff Bemo, bỏ ngày 2026-07-01`
  let the AI choose the registered structured commands.

The Bemo skill owns late-day filtering through JSON-stdin commands:
`bemo.prepare-timeoff` builds a digest-bound plan and `bemo.create-timeoff`
executes only that plan after `confirm bemo.create-timeoff <token>`. The core
agent has no Bemo-specific router branch. Unknown, malformed, duplicate,
expired, or tampered plans fail closed.

## Add Commands

Edit `commands.json`:

```json
{
  "allow": [
    {
      "name": "my-skill.run",
      "label": "Run my skill",
      "skillSlug": "my-skill",
      "aliases": ["/my-command"],
      "cwd": "../skills/my-skill",
      "argv": ["python3", "scripts/run.py"],
      "requiresConfirmation": true
    }
  ]
}
```

`cwd` is relative to this `agent` folder unless it is absolute. Every command
is checked by the central permission policy before execution; an absolute path
outside `permissions.workspaceRoot` is refused even when the command is in the
allowlist. Commands use a fixed `argv` array and run without a shell. The child
process receives only a small allowlist of non-secret environment variables.
Catalog loading fails if a command has duplicate aliases, a missing skill, or a
stale working directory. Wildcard and raw-shell commands are not supported.

Commands requiring confirmation show executable, arguments, working directory,
and timeout before the user approves them. Mark external mutations with
`externalSideEffect: true`; this forces confirmation even if a catalog entry is
misconfigured with `requiresConfirmation: false`. Approval uses
`confirm <commandName> <token>`; the token is derived from the exact preview and
is rejected if the stored action or preview changes.

Commands may optionally declare `inputMode: "json-stdin"` and an `inputSchema`.
Those commands are exposed to the AI as typed tools; arguments are schema
validated before execution and sent over stdin instead of argv.

## Permission Policy

Configure local authority in `config.json`:

```json
{
  "permissions": {
    "workspaceRoot": "..",
    "allowedReadRoots": [".."],
    "allowedWriteRoots": [".", "../skills"],
    "deniedPaths": ["/etc", "/usr", "/bin", "/boot", "/proc", "/sys", "/dev"]
  }
}
```

Relative policy paths resolve from the `agent` folder. `.env`, `.git`,
`node_modules`, credential/secret filenames, and private-key file extensions
are denied by default. Deny rules override allowed roots. Writes, patches,
deletes, and commands marked `requiresConfirmation` or `externalSideEffect`
must receive explicit confirmation before execution.

## Internal File Tools

`src/tools/files.ts` provides policy-gated internal actions for future Router
integration:

```ts
type FileToolAction =
  | { kind: "file.read"; path: string; maxBytes?: number }
  | { kind: "file.list"; path: string; maxEntries?: number }
  | { kind: "file.exists"; path: string }
  | { kind: "file.mkdir"; path: string }
  | { kind: "file.write"; path: string; content: string }
  | { kind: "file.patch"; path: string; search: string; replacement: string };
```

Every call returns `{ ok, code, summary, data? }`. Mutations called without a
trusted confirmation return `CONFIRMATION_REQUIRED` and structured preview data
without changing the filesystem. Binary content and delete are unsupported.
Reads default to 64 KiB and show an explicit truncation marker; mutations are
limited to 1 MiB. File contents are never written to trace events.
