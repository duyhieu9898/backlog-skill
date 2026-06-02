#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backlog_tool.settings import load_config, load_env_file, log_event
from workflows.story_task_overview import my_story_task_overview


def build_parser():
    parser = argparse.ArgumentParser(description="List Story/Task overview assigned to the default user.")
    parser.add_argument("--project", help="Project key. Uses default_project_key when omitted.")
    parser.add_argument("--query", help="Optional keyword query")
    return parser


def main():
    load_env_file()
    parser = build_parser()
    args = parser.parse_args()
    config = load_config()
    log_event("info", "command_start", command="story_task_overview", project=args.project, dry_run=True)
    try:
        result = my_story_task_overview(config, project_key=args.project, query=args.query)
        log_event("info", "command_end", command="story_task_overview")
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as error:
        log_event("error", "command_error", command="story_task_overview", error=error)
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
