# Agent

Telegram command router for local agents in this `my-agents` folder.

## Run

```bash
npm install
npm start
```

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

## Add Commands

Edit `commands.json`:

```json
{
  "/my-command": {
    "label": "My command",
    "cwd": "../some-agent",
    "command": "python3 scripts/run.py"
  }
}
```

`cwd` is relative to this `agent` folder unless it is absolute. Every command
is checked by the central permission policy before execution; an absolute path
outside `permissions.workspaceRoot` is refused even when the command is in the
allowlist.

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
