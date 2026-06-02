#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backlog_tool.settings import load_config, load_env_file, log_event, view_base_url
from workflows.ut_bug import create_subtask_bug


def build_parser():
    parser = argparse.ArgumentParser(description="Create a Backlog sub-task bug based on HieuND's rules.")
    parser.add_argument("--project", help="Project key from config/backlog.json. Uses default_project_key when omitted.")
    parser.add_argument("--dry-run", action="store_true", help="Print payload without calling write API")
    parser.add_argument("parent_key", help="Parent Issue Key (e.g., OOP-10233)")
    parser.add_argument("module", help="Module Name (e.g., A020100|FE)")
    parser.add_argument("description", help="Issue Description")
    return parser


def main():
    load_env_file()
    parser = build_parser()
    args = parser.parse_args()
    config = load_config()
    log_event(
        "info",
        "command_start",
        command="ut_bug",
        project=args.project or config.get("default_project_key"),
        parent_issue=args.parent_key,
        dry_run=args.dry_run,
    )

    try:
        issue = create_subtask_bug(
            config,
            args.project,
            args.parent_key,
            args.module,
            args.description,
            dry_run=args.dry_run,
        )
        if args.dry_run:
            print(json.dumps(issue, indent=2, ensure_ascii=False))
            log_event("info", "command_end", command="ut_bug")
            return
        print(f"Successfully created bug: {issue['issueKey']}")
        print(f"Link: {view_base_url(config)}/view/{issue['issueKey']}")
        log_event("info", "command_end", command="ut_bug", issue=issue.get("issueKey"))
    except Exception as error:
        log_event("error", "command_error", command="ut_bug", error=error)
        print(f"Error: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
