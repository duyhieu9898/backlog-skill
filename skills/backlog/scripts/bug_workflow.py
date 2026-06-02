#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workflows.resolve_bug import (
    get_bug_context,
    my_open_bugs,
    resolve_bug,
)
from backlog_tool.settings import load_config, load_env_file, log_event


def build_parser():
    parser = argparse.ArgumentParser(description="Personal Backlog bug workflow helpers.")
    subparsers = parser.add_subparsers(dest="command")

    my_open = subparsers.add_parser("my-open", help="List open Bug issues assigned to the default user")
    my_open.add_argument("--project", help="Project key. Uses default_project_key when omitted.")
    my_open.add_argument("--query", help="Optional keyword query")

    context = subparsers.add_parser("context", help="Get structured bug context from issue description")
    context.add_argument("issue_key", help="Issue key, e.g. AQM-123")

    resolve = subparsers.add_parser("resolve", help="Prepare or apply personal resolve-bug workflow")
    resolve.add_argument("issue_key", help="Bug issue key, e.g. AQM-123")
    resolve.add_argument("--status", help="Status name or ID. Uses workflow config when omitted.")
    resolve.add_argument("--actual-hours", type=float, help="Actual hours to set")
    resolve.add_argument("--estimated-hours", type=float, help="Estimated hours to set")
    resolve.add_argument("--qc-activity", help="QC Activity custom field value")
    resolve.add_argument("--cause-category", help="Cause Category custom field value")
    resolve.add_argument("--bug-origin", help="Bug Origin custom field value")
    resolve.add_argument("--impacted", help="Impacted custom field value")
    resolve.add_argument("--resolution", help="Resolution custom field value if configured")
    resolve.add_argument("--comment", help="Update comment")
    resolve.add_argument("--fix-description", help="Text used for Corrective Action: fixed <text lowercased>")
    resolve.add_argument("--apply", action="store_true", help="Write to Backlog. Omit for dry-run.")

    return parser


def run_command(config, args):
    if args.command == "my-open":
        return my_open_bugs(config, project_key=args.project, query=args.query)
    if args.command == "context":
        return get_bug_context(config, args.issue_key)
    if args.command == "resolve":
        return resolve_bug(
            config,
            args.issue_key,
            dry_run=not args.apply,
            status=args.status,
            actual_hours=args.actual_hours,
            estimated_hours=args.estimated_hours,
            qc_activity=args.qc_activity,
            cause_category=args.cause_category,
            bug_origin=args.bug_origin,
            impacted=args.impacted,
            resolution=args.resolution,
            comment=args.comment,
            fix_description=args.fix_description,
        )
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
        command=f"bug_workflow:{args.command}",
        dry_run=not getattr(args, "apply", False) if args.command == "resolve" else None,
    )
    try:
        result = run_command(config, args)
        log_event("info", "command_end", command=f"bug_workflow:{args.command}")
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as error:
        log_event("error", "command_error", command=f"bug_workflow:{args.command}", error=error)
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
