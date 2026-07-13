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

## Local CLI

Run one message through the same Router used by Telegram, without starting
Telegram polling or the background scheduler:

```bash
npm run cli -- "/status"
printf '%s' '/commands' | npm run cli
```

The CLI uses the stable local chat ID `local-cli`, so a preview in one
invocation can be confirmed in the next with the same digest-bound command.
It is a transport adapter, not a privileged mode: permission policy, command
allowlisting, confirmations, chat persistence, traces, and AI tool validation
remain in effect. Router replies go to stdout; operational logs go to stderr.

## Debug Commands

- `/status` — uptime, current command, pending confirmations, loaded commands,
  loaded skills, skill-registry errors, and SQLite path.
- `/last` — latest command result and output tail.
- `/last-error` — latest command or tool failure with trace ID.
- `/stop` — immediately request termination of the one command currently
  executing; it does not wait behind that command's chat queue.
- `/debug <traceId>` — trace events for one execution.
- `/commands` — allowlisted commands grouped by skill.
- `/schedule` — configured scheduled checks and delivery mode.
- `/schedule show <name>` — one scheduled check's durable state.
- `/schedule history <name>` — recent durable scheduled runs.
- `/schedule run <name>` — run one configured scheduled check immediately.
- `/schedule enable|disable <name>` — change schedule state after confirmation.
- `/schedule interval <name> <minutes>` — change interval after confirmation.
- `/schedule delivery <name> <telegram|silent>` — change delivery after confirmation.
- `/skills` — loaded skill names and descriptions, plus any invalid skill
  metadata that was skipped during scanning.
- `/help` — command summary.

## Background CLI

Install the `my-agent` CLI and systemd user service:

```bash
./scripts/my-agent install
```

On Debian/Ubuntu Linux, `install` also installs the desktop-automation
prerequisites used by the X11 adapter: `scrot`, `libgtk-3-bin`, `xdotool`,
`wmctrl`, and `python3-pyatspi`. It will ask for the local administrator
password through `sudo`. Re-run only that prerequisite step with:

```bash
./scripts/my-agent desktop-deps
```

The adapter stays unavailable outside an X11 session or if the dependencies
cannot be installed. `MY_AGENT_SKIP_DESKTOP_DEPS=1` skips this explicit setup
step for non-desktop or CI installations.

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

## AI Tool Retry Guard

The AI tool loop allows one retry of the same tool call after a failure. If the
same tool name, arguments, and failure code occur twice in one request, the
loop stops immediately instead of spending the remaining tool steps. The reply
includes the failed tool and code so the user can adjust the request or choose
a different action.

Transient AI-provider failures (`429`, `5xx`, timeouts, or connection resets)
retry at most twice with short backoff delays. Invalid or permanent provider
errors do not retry.

## AI Prompt Protocol

Every provider receives the same structured prompt context: a system policy,
role-preserved and redacted conversation history, the current user message,
and runtime time, timezone, and locale. The current message is never repeated
in history. General conversation receives no tools; a matched skill receives
only that skill's commands, while file-intent requests receive only file tools.
Gemini uses native system instructions and JSON-schema output; server-side
validation remains the final guard.

Before committing agent changes, run:

```bash
npm run verify
```

It builds and runs the automated tests, then checks both staged and unstaged
diffs for whitespace errors.

## Raw AI Interaction Logs

Every provider request, response, and provider error is written as raw JSONL
to `logs/ai-interactions/<YYYY-MM-DD>/<traceId>.jsonl`. A compact
`logs/ai-interactions/index.jsonl` stores only metadata for discovery, so an
agent can find a trace without reading raw payloads. Use:

```bash
npm run ai-logs -- list --limit 20
npm run ai-logs -- show <traceId>
npm run ai-logs -- show <traceId> --direction response
```

Records include `traceId`, provider, model, direction, timestamp, and the
complete payload. The directory is ignored by Git and intentionally not
redacted; protect it as sensitive local debugging data.

## Scheduled Checks

Configure read-only scheduled checks in `config.json`:

```json
{
  "schedules": [
    {
      "name": "bemo-late",
      "label": "Bemo late-day read-only check",
      "command": "bemo.late-list",
      "dailyAt": "17:00",
      "enabled": true,
      "delivery": "telegram",
      "notifyOnChangeOnly": true,
      "prepareEffect": {
        "prepareCommand": "bemo.prepare-timeoff",
        "prepareInput": { "skipDates": [] },
        "effectCommand": "bemo.create-timeoff"
      }
    }
  ]
}
```

Each schedule uses exactly one timing field: `intervalMinutes` for a repeating
interval, or `dailyAt` for one fixed 24-hour local time. `dailyAt` is evaluated
in the configured runtime timezone, so a service restart does not shift its
next execution. Scheduled checks may reference only allowlisted commands that do not require
confirmation and do not declare `externalSideEffect`. Configured checks
bootstrap a durable SQLite job registry keyed by stable schedule `name`. After
a job exists, SQLite is the source of truth for runtime controls such as
enabled state, interval, delivery mode, change-only behavior, next run time,
and last run metadata. Restarting the service refreshes job metadata such as
label, command, and follow-up prepare/effect config from `config.json`, but it
does not overwrite confirmed runtime changes. The background service polls due
jobs from SQLite, so confirmed changes to state, interval, or delivery do not
require a service restart.

Each scheduled job has a monotonically increasing `version`. Schedule update
previews bind to the current version, so a stale confirmation or future
dashboard save cannot silently overwrite a newer edit. Due jobs are claimed
with a short SQLite lease before execution; a second runner that sees the same
due row cannot claim or run it while the lease is active.

Delivery can be `telegram` or `silent`. `notifyOnChangeOnly` suppresses
duplicate successful Telegram notifications when command output has not
changed; failures still notify. A schedule may prepare a follow-up external
effect by creating a normal digest-bound confirmation preview, but it never
executes that effect automatically.

`/schedule` lists checks, `/schedule show <name>` shows durable state,
`/schedule history <name>` shows recent runs, `/schedule run <name>` runs one
immediately, and `/status` shows the latest scheduled result.

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
