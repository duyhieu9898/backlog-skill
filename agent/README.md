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

The CLI uses the stable local chat ID `local-cli`, so an approval created in one
invocation can be approved or rejected in the next with `approve <short-id>`
or `reject <short-id>`. It is a transport adapter, not a privileged mode:
permission policy, scoped approvals, chat persistence, traces, and AI tool
validation remain in effect. Router replies go to stdout; operational logs go
to stderr.

## Debug Commands

- `/status` — uptime, current command, pending approvals, loaded command
  shortcuts,
  loaded skills, skill-registry errors, and SQLite path.
- `/last` — latest command result and output tail.
- `/last-error` — latest command or tool failure with trace ID.
- `/stop` — immediately request termination of the one command currently
  executing; it does not wait behind that command's chat queue.
- `/debug <traceId>` — trace events for one execution.
- `/commands` — registered command shortcuts grouped by skill; this is not a
  permission allowlist.
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

The Bemo skill owns late-day filtering through JSON-stdin command shortcuts.
Its consequential create step receives the run-scoped approval when one is
needed. The core agent has no Bemo-specific router branch. Unknown, malformed,
duplicate, expired, or tampered pending actions fail closed through the shared
approval service.

## Register Command Shortcuts

`commands.json` remains useful for named skill shortcuts, aliases, structured
JSON-stdin input, and discoverability. It is not the list of commands the agent
is permitted to run: `command.run` can execute arbitrary argv or a necessary
shell command after `ToolGateway` evaluates its actual impact.

Edit `commands.json` to add a shortcut:

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

`cwd` is relative to this `agent` folder unless it is absolute. Every shortcut
and arbitrary command is evaluated by `ToolGateway` before execution; policy
uses executable, arguments, shell syntax, cwd, target, user intent, active
approval, impact, and recoverability. Prefer fixed `argv`; use shell only for
an actual pipeline, redirect, glob, conditional, or multi-step script. The
command service supplies a reduced non-secret environment, captures bounded
output, and kills the process group on timeout. Catalog loading still rejects
duplicate aliases, a missing skill, or a stale working directory.

Significant actions show a concise task scope and receive one run-scoped
approval. Telegram uses Approve/Reject buttons; CLI uses the short pending ID
or interactive yes/no. A backend-only digest binds pending action, owner/chat,
run, expiry, and action content; a material change invalidates the old pending
approval. Equivalent follow-on steps in scope do not ask again.

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

Records may contain prompts, browser/file content, cookies, tokens, command
output, or credentials. Raw logging is configurable, retained for a bounded
period, and redacted before persistence; Git ignore alone is not a safety
control. Protect the directory with appropriate local file permissions.

## Scheduled Checks

Configure static schedules in `config.json`:

```json
{
  "schedules": [
    {
      "name": "bemo-late",
      "label": "Bemo late-day check",
      "command": "bemo.late-list",
      "cron": "0 17 * * 1-5",
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

Each schedule uses a standard 5-field cron expression in `cron` (evaluated in
the configured timezone via `croner`). Static config schedules are authoritative
for config-owned rows; runtime-created schedules use `source: "runtime"` and
are never overwritten by config seeding. Configured behavior is pre-approved
for its declared objective and still executes through `AgentRuntime` →
`ToolGateway` → policy. The scheduler pauses only for a materially broader,
newly risky, or destructive action. Execution is at-least-once, so effects
should be idempotent where practical.

Due jobs are claimed with a short SQLite lease before execution; a second
runner that sees the same due row cannot claim or run it while the lease is
active.

Delivery can be `telegram` or `silent`. `notifyOnChangeOnly` suppresses
duplicate successful Telegram notifications when command output has not
changed; failures still notify. A schedule must pause for a new external effect
that is not covered by its configured owner-approved objective.

`/schedule` lists checks, `/schedule show <name>` shows durable state,
`/schedule history <name>` shows recent runs, `/schedule run <name>` runs one
immediately, and `/status` shows the latest scheduled result.

## Permission Policy

The agent is a trusted local operator, not an OS sandbox. It allows routine,
reasonable, recoverable work by default; asks for approval only for significant
system/data/external/sensitive impact; and hard-denies clearly destructive
actions. Default roots make routine file work convenient but are not permanent
fences. Paths are normalized and symlink-resolved, sensitive material needs
contextual approval, and destructive targets remain denied. See
`docs/ARCHITECTURE.md` for the current policy and invariants.

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

Every call returns `{ ok, code, summary, data? }`. The gateway decides whether
the action is routine, requires scoped approval, or is destructive before this
service executes it. Reads default to 64 KiB and show an explicit truncation
marker; mutations are limited to 1 MiB. File contents are never written to
trace events.
