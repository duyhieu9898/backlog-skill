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

`cwd` is relative to this `agent` folder unless it is absolute.
