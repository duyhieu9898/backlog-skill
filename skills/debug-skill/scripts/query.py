#!/usr/bin/env python3
"""command_runs drill-down for the Debug & Eval Loop skill.

Scope (narrowed): ONLY command_runs — terminal command execution history
(command, cwd, status, exit code, output_tail, error). trace_events and raw
AI-interaction logs are handled by `agent/scripts/dev.js` (`eval`, `logs`) which
is wired to the correct DB and doesn't redact token fields. This script exists
solely because command_runs is the one drill-down dev.js does not surface.

DB resolution: respects AGENT_DB_FILE if set (use agent/eval/eval.sqlite inside
the eval loop), else falls back to the production agent/data/agent.sqlite.
"""

import sys
import os
import sqlite3
import json

# Resolve paths: skills/debug-skill/scripts/query.py -> my-agents/agent
skills_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
agent_dir = os.path.join(os.path.dirname(skills_dir), 'agent')
DEFAULT_SQLITE = os.path.join(agent_dir, 'data', 'agent.sqlite')


def sqlite_file():
    # Honor AGENT_DB_FILE so the eval loop queries the eval DB, not prod. Relative
    # values resolve against agentDir (cwd-agnostic) — set AGENT_DB_FILE=eval/eval.sqlite
    # from anywhere. Default: production agent/data/agent.sqlite.
    f = os.environ.get('AGENT_DB_FILE')
    if f:
        return f if os.path.isabs(f) else os.path.join(agent_dir, f)
    return DEFAULT_SQLITE


def get_db():
    f = sqlite_file()
    if not os.path.exists(f):
        print(f"Error: Database file not found at {f} (set AGENT_DB_FILE to override)")
        sys.exit(1)
    return sqlite3.connect(f)


def list_command_runs(limit=10):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT trace_id, command_name, status, started_at, finished_at, exit_code, error_message "
        "FROM command_runs ORDER BY started_at DESC LIMIT ?",
        (limit,)
    )
    rows = cursor.fetchall()
    if not rows:
        print(f"No command runs recorded in {sqlite_file()}.")
        return

    print(f"--- Recent Command Runs (Last {limit}) from {sqlite_file()} ---")
    for trace_id, name, status, started, finished, code, err in rows:
        print(f"[{started}] Command: {name} | Status: {status} | Exit Code: {code}")
        print(f"  Trace ID: {trace_id}")
        if err:
            print(f"  Error: {err}")
        print()


def get_command_run(trace_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT command_name, cwd, command, status, started_at, finished_at, exit_code, output_tail, error_message "
        "FROM command_runs WHERE trace_id = ?",
        (trace_id,)
    )
    rows = cursor.fetchall()
    if not rows:
        print(f"No command runs found for trace ID: {trace_id} in {sqlite_file()}")
        return

    print(f"--- Command Runs for Trace {trace_id} ---")
    for name, cwd, cmd, status, started, finished, code, output, err in rows:
        print(f"Command: {name}")
        print(f"Cwd: {cwd}")
        print(f"Command line: {cmd}")
        print(f"Status: {status} | Started: {started} | Finished: {finished} | Exit Code: {code}")
        if err:
            print(f"Error: {err}")
        if output:
            print(f"Output Tail:\n{output}")
        print()


def print_usage():
    print("Usage: python query.py <command> [args]")
    print("Scope: command_runs only. For trace_events/ai-logs use `agent/scripts/dev.js eval|logs`.")
    print(f"DB: AGENT_DB_FILE env if set, else {DEFAULT_SQLITE}")
    print("Commands:")
    print("  commands [limit]      - Show recent command runs (default 10)")
    print("  runs <trace_id>       - Show detailed command runs for trace ID")


def dispatch(action, trace_id, limit):
    if action == "commands":
        list_command_runs(limit)
    elif action == "runs":
        if not trace_id:
            print("Error: Missing traceId")
            sys.exit(1)
        get_command_run(trace_id)
    else:
        print(f"Unknown action: {action}")
        print_usage()
        sys.exit(1)


if __name__ == "__main__":
    # Argv mode is primary — it works when invoked by agents/non-tty shells
    # (stdin is a closed pipe there, so a `not sys.stdin.isatty()` check would
    # wrongly force JSON mode and fail on empty input).
    if len(sys.argv) >= 2:
        cmd = sys.argv[1]
        if cmd == "commands":
            list_command_runs(int(sys.argv[2]) if len(sys.argv) >= 3 else 10)
        elif cmd == "runs":
            if len(sys.argv) < 3:
                print("Error: Missing trace_id")
                sys.exit(1)
            get_command_run(sys.argv[2])
        else:
            print(f"Unknown command: {cmd}")
            print_usage()
            sys.exit(1)
    else:
        # No argv — try JSON on stdin (debug.query tool style) if data is present.
        data = sys.stdin.read().strip()
        if not data:
            print_usage()
            sys.exit(0)
        try:
            j = json.loads(data)
            dispatch(j.get("action"), j.get("traceId"), int(j.get("limit", 10)))
        except Exception as e:
            print(f"Error reading JSON from stdin: {e}")
            sys.exit(1)
