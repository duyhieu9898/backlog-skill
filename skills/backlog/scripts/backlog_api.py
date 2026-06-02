#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backlog_tool.issue_service import create_issue, get_issue, get_issues, update_issue
from backlog_tool.settings import load_config, load_env_file, log_event, resolve_user_id


def add_common_issue_fields(parser):
    parser.add_argument("--desc", help="Issue description")
    parser.add_argument("--priority", help="Priority ID or name")
    parser.add_argument("--assignee", help="Assignee user ref from config.users or raw user ID")
    parser.add_argument("--category", help="Category ID or name from config/projects/<PROJECT>.json")
    parser.add_argument("--start-date", help="YYYY-MM-DD")
    parser.add_argument("--due-date", help="YYYY-MM-DD")
    parser.add_argument("--estimated-hours", type=float, help="Estimated hours")
    parser.add_argument("--actual-hours", type=float, help="Actual hours")
    parser.add_argument(
        "--custom",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Custom field key/value, e.g. qc_activity='Unit Test'. Can be repeated.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print payload without calling write API")


def add_project_field(parser):
    parser.add_argument(
        "--project",
        help="Project key from config/backlog.json. Uses default_project_key when omitted.",
    )


def build_parser():
    parser = argparse.ArgumentParser(
        description="Backlog API CLI. Uses default_project_key unless --project is provided.",
    )
    subparsers = parser.add_subparsers(dest="command")

    get_parser = subparsers.add_parser("get")
    get_parser.add_argument("issue_id", help="Issue ID or key, e.g. OOP-123")

    list_parser = subparsers.add_parser("list")
    add_project_field(list_parser)
    list_parser.add_argument("--query", help="Search keyword")
    list_parser.add_argument("--assignee", type=int, help="Assignee ID")
    list_parser.add_argument("--me", action="store_true", help="Filter by configured default assignee")

    create_parser = subparsers.add_parser("create")
    add_project_field(create_parser)
    create_parser.add_argument("summary", help="Issue summary")
    create_parser.add_argument("--issue-type", help="Issue type ID or name")
    create_parser.add_argument("--parent", help="Parent issue key, e.g. OOP-123")
    add_common_issue_fields(create_parser)

    update_parser = subparsers.add_parser("update")
    add_project_field(update_parser)
    update_parser.add_argument("issue_id", help="Issue ID or key, e.g. OOP-123")
    update_parser.add_argument("--summary", help="New summary")
    update_parser.add_argument("--status", help="Status ID or name")
    update_parser.add_argument("--comment", help="Add update comment")
    add_common_issue_fields(update_parser)

    return parser


def run_command(config, args):
    if args.command == "get":
        return get_issue(config, args.issue_id)
    if args.command == "list":
        me = config.get("defaults", {}).get("assignee", "me")
        assignee_id = resolve_user_id(config, me) if args.me else args.assignee
        return get_issues(config, args.project, args.query, assignee_id)
    if args.command == "create":
        return create_issue(config, args)
    if args.command == "update":
        return update_issue(config, args)
    return None


def main():
    load_env_file()
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    config = load_config()
    log_event(
        "info",
        "command_start",
        command=args.command,
        project=getattr(args, "project", None) or config.get("default_project_key"),
        dry_run=getattr(args, "dry_run", False),
    )

    try:
        result = run_command(config, args)
        log_event("info", "command_end", command=args.command)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as error:
        log_event("error", "command_error", command=args.command, error=error)
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
