#!/usr/bin/env python3
"""Session logger for CLI outputs.

Each CLI run appends one JSONL entry to a date+command file under
logs/sessions/<YYYY-MM-DD>_<command>.jsonl

This gives a durable trace per command per day, easy to compare across runs.
"""
import json
import os
from datetime import datetime, timezone

from .settings import LOG_DIR

SESSIONS_DIR = os.path.join(LOG_DIR, "sessions")


def _now():
    return datetime.now(timezone.utc).astimezone()


def _safe_command(command):
    """Turn 'bug:my-open' into 'bug_my-open' for filename."""
    return command.replace(":", "_").replace("/", "_").replace(" ", "_")


def session_path(command, ts=None):
    ts = ts or _now()
    date_str = ts.strftime("%Y-%m-%d")
    return os.path.join(SESSIONS_DIR, f"{date_str}_{_safe_command(command)}.jsonl")


def log_cli(command, cli_output, project=None, issue_key=None):
    """Log a CLI execution. Called automatically by cli.py after each run."""
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    ts = _now()
    record = {
        "ts": ts.isoformat(timespec="seconds"),
        "step": "cli",
        "command": command,
        "project": project,
        "issueKey": issue_key,
        "cliOutput": cli_output,
    }
    path = session_path(command, ts)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def log_ai(command, user_request, ai_response, issue_key=None):
    """Log an AI interaction. Called by hook after tool use."""
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    ts = _now()
    record = {
        "ts": ts.isoformat(timespec="seconds"),
        "step": "ai",
        "command": command,
        "issueKey": issue_key,
        "userRequest": user_request,
        "aiResponse": ai_response,
    }
    path = session_path(command, ts)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def list_sessions():
    """List available session files."""
    if not os.path.isdir(SESSIONS_DIR):
        return []
    files = sorted(f for f in os.listdir(SESSIONS_DIR) if f.endswith(".jsonl"))
    return files


def read_session(filename):
    """Read all entries from a session file."""
    path = os.path.join(SESSIONS_DIR, filename)
    if not os.path.exists(path):
        return []
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries
