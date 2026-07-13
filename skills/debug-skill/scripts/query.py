import sys
import os
import sqlite3
import json

# Resolve paths
skills_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
agent_dir = os.path.join(os.path.dirname(skills_dir), 'agent')
sqlite_file = os.path.join(agent_dir, 'data', 'agent.sqlite')
logs_dir = os.path.join(agent_dir, 'logs', 'ai-interactions')

def get_db():
    if not os.path.exists(sqlite_file):
        print(f"Error: Database file not found at {sqlite_file}")
        sys.exit(1)
    return sqlite3.connect(sqlite_file)

def list_traces(trace_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT event, payload_json, created_at FROM trace_events WHERE trace_id = ? ORDER BY created_at ASC",
        (trace_id,)
    )
    rows = cursor.fetchall()
    if not rows:
        print(f"No trace events found for trace ID: {trace_id}")
        return
    
    print(f"--- Trace Events for {trace_id} ---")
    for event, payload_json, created_at in rows:
        try:
            payload = json.loads(payload_json)
            payload_str = json.dumps(payload, indent=2)
        except:
            payload_str = payload_json
        print(f"[{created_at}] Event: {event}\nPayload: {payload_str}\n")

def list_command_runs(limit=10):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT trace_id, command_name, status, started_at, finished_at, exit_code, error_message FROM command_runs ORDER BY started_at DESC LIMIT ?",
        (limit,)
    )
    rows = cursor.fetchall()
    if not rows:
        print("No command runs recorded.")
        return
    
    print(f"--- Recent Command Runs (Last {limit}) ---")
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
        "SELECT command_name, cwd, command, status, started_at, finished_at, exit_code, output_tail, error_message FROM command_runs WHERE trace_id = ?",
        (trace_id,)
    )
    rows = cursor.fetchall()
    if not rows:
        print(f"No command runs found for trace ID: {trace_id}")
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

def get_ai_logs(trace_id):
    found = False
    for root, dirs, files in os.walk(logs_dir):
        for file in files:
            if file == f"{trace_id}.jsonl":
                found_path = os.path.join(root, file)
                found = True
                print(f"--- AI Interactions for Trace {trace_id} ({found_path}) ---")
                with open(found_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        try:
                            record = json.loads(line.strip())
                            print(f"[{record.get('at')}] Direction: {record.get('direction')} | Provider: {record.get('provider')} | Model: {record.get('model')}")
                            payload = record.get('payload')
                            if isinstance(payload, dict) and 'contents' in payload:
                                contents = payload['contents']
                                print("  Contents:")
                                for turn in contents:
                                    role = turn.get('role')
                                    parts = turn.get('parts', [])
                                    text = parts[0].get('text') if parts else ''
                                    print(f"    {role}: {text[:200]}...")
                            else:
                                print(json.dumps(payload, indent=2)[:1000] + "...")
                            print("-" * 40)
                        except Exception as e:
                            print(f"Error parsing log line: {e}")
                            print(line)
    if not found:
        print(f"No AI interaction logs found for trace ID: {trace_id} in {logs_dir}")

def print_usage():
    print("Usage: python query.py <command> [args]")
    print("Commands:")
    print("  traces <trace_id>     - Show trace events for trace ID")
    print("  commands [limit]      - Show recent command runs")
    print("  runs <trace_id>       - Show detailed command runs for trace ID")
    print("  ai-logs <trace_id>    - Show raw AI interaction logs for trace ID")

if __name__ == "__main__":
    if not sys.stdin.isatty():
        try:
            data = json.load(sys.stdin)
            action = data.get("action")
            trace_id = data.get("traceId")
            limit = data.get("limit", 10)
            
            if action == "traces":
                if not trace_id:
                    print("Error: Missing traceId")
                    sys.exit(1)
                list_traces(trace_id)
            elif action == "commands":
                list_command_runs(limit)
            elif action == "runs":
                if not trace_id:
                    print("Error: Missing traceId")
                    sys.exit(1)
                get_command_run(trace_id)
            elif action == "ai-logs":
                if not trace_id:
                    print("Error: Missing traceId")
                    sys.exit(1)
                get_ai_logs(trace_id)
            else:
                print(f"Unknown action: {action}")
                sys.exit(1)
        except Exception as e:
            print(f"Error reading JSON from stdin: {e}")
            sys.exit(1)
    else:
        if len(sys.argv) < 2:
            print_usage()
            sys.exit(1)
            
        cmd = sys.argv[1]
        if cmd == "traces":
            if len(sys.argv) < 3:
                print("Error: Missing trace_id")
                sys.exit(1)
            list_traces(sys.argv[2])
        elif cmd == "commands":
            limit = int(sys.argv[2]) if len(sys.argv) >= 3 else 10
            list_command_runs(limit)
        elif cmd == "runs":
            if len(sys.argv) < 3:
                print("Error: Missing trace_id")
                sys.exit(1)
            get_command_run(sys.argv[2])
        elif cmd == "ai-logs":
            if len(sys.argv) < 3:
                print("Error: Missing trace_id")
                sys.exit(1)
            get_ai_logs(sys.argv[2])
        else:
            print(f"Unknown command: {cmd}")
            print_usage()
            sys.exit(1)
