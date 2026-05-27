#!/usr/bin/env python3
import argparse
import json
import sys

import requests

from backlog_settings import (
    api_base_url,
    load_config,
    load_env_file,
    require_api_key,
    resolve_project,
    resolve_user_id,
)

load_env_file()


def get_project_id(config, project):
    if project.get("id"):
        return project["id"]

    resp = requests.get(
        f"{api_base_url(config)}/projects/{project['key']}",
        params={"apiKey": require_api_key()},
    )
    resp.raise_for_status()
    return resp.json()["id"]


def request_json(config, method, path, data=None):
    resp = requests.request(
        method,
        f"{api_base_url(config)}{path}",
        params={"apiKey": require_api_key()},
        data=data,
    )
    resp.raise_for_status()
    return resp.json()


def find_option(options, selected, label):
    if selected is None:
        return None
    selected_text = str(selected)
    if selected_text.isdigit():
        return int(selected_text)

    for option in options:
        if option.get("name") == selected:
            return option.get("id")
    available = ", ".join(str(option.get("name")) for option in options)
    raise ValueError(f"Unknown {label} '{selected}'. Available: {available}")


def resolve_assignee(config, selected):
    if selected is None:
        return None
    if str(selected).isdigit():
        return int(selected)
    return resolve_user_id(config, selected)


def resolve_issue_type(project, selected):
    bug = project.get("bug", {})
    return find_option(
        bug.get("_issue_type_options", bug.get("issue_type_options", [])),
        selected,
        "issue type",
    )


def resolve_category(project, selected):
    bug = project.get("bug", {})
    return find_option(
        bug.get("_category_options", bug.get("category_options", [])),
        selected,
        "category",
    )


def resolve_priority(config, selected):
    if selected is None:
        return None
    if str(selected).isdigit():
        return int(selected)
    priorities = request_json(config, "GET", "/priorities")
    return find_option(priorities, selected, "priority")


def resolve_status(config, project, selected):
    if selected is None:
        return None
    if str(selected).isdigit():
        return int(selected)
    statuses = request_json(config, "GET", f"/projects/{project['key']}/statuses")
    return find_option(statuses, selected, "status")


def resolve_parent_issue_id(config, parent_issue_key):
    if not parent_issue_key:
        return None
    issue = request_json(config, "GET", f"/issues/{parent_issue_key}")
    return issue["id"]


def parse_custom_args(custom_args):
    values = {}
    for item in custom_args or []:
        if "=" not in item:
            raise ValueError(f"Invalid custom field '{item}'. Use key=value.")
        key, value = item.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def resolve_custom_fields(project, custom_args):
    payload = {}
    fields = project.get("bug", {}).get("custom_fields", {})
    for key, selected in parse_custom_args(custom_args).items():
        field = fields.get(key)
        if not field:
            available = ", ".join(sorted(fields.keys()))
            raise ValueError(f"Unknown custom field '{key}'. Available: {available}")
        options = field.get("value_options", [])
        payload[field["field"]] = find_option(options, selected, field.get("label") or key) if options else selected
    return payload


def get_issues(config, query=None, assignee_id=None):
    project = resolve_project(config)
    p_id = get_project_id(config, project)
    params = {
        "apiKey": require_api_key(),
        "projectId[]": [p_id],
        "count": 100,
    }
    if query:
        params["keyword"] = query
    if assignee_id:
        params["assigneeId[]"] = [assignee_id]

    resp = requests.get(f"{api_base_url(config)}/issues", params=params)
    resp.raise_for_status()
    return resp.json()


def build_create_payload(config, args):
    project = resolve_project(config)
    defaults = config.get("defaults", {})
    bug_defaults = config.get("bug_defaults", {})
    issue_type = args.issue_type or bug_defaults.get("issue_type")
    priority = args.priority or defaults.get("priority_id", 3)
    assignee = args.assignee or defaults.get("assignee")

    data = {
        "projectId": get_project_id(config, project),
        "summary": args.summary,
        "issueTypeId": resolve_issue_type(project, issue_type),
        "priorityId": resolve_priority(config, priority),
    }
    optional_values = {
        "description": args.desc,
        "assigneeId": resolve_assignee(config, assignee),
        "parentIssueId": resolve_parent_issue_id(config, args.parent),
        "startDate": args.start_date,
        "dueDate": args.due_date,
        "estimatedHours": args.estimated_hours,
        "actualHours": args.actual_hours,
    }
    data.update({key: value for key, value in optional_values.items() if value is not None})

    category_id = resolve_category(project, args.category)
    if category_id:
        data["categoryId[]"] = [category_id]
    data.update(resolve_custom_fields(project, args.custom))
    return data


def create_issue(config, args):
    data = build_create_payload(config, args)
    if args.dry_run:
        return {"dryRun": True, "payload": data}
    return request_json(config, "POST", "/issues", data=data)


def build_update_payload(config, args):
    project = resolve_project(config)
    data = {}
    optional_values = {
        "summary": args.summary,
        "description": args.desc,
        "statusId": resolve_status(config, project, args.status),
        "priorityId": resolve_priority(config, args.priority),
        "assigneeId": resolve_assignee(config, args.assignee),
        "startDate": args.start_date,
        "dueDate": args.due_date,
        "estimatedHours": args.estimated_hours,
        "actualHours": args.actual_hours,
        "comment": args.comment,
    }
    data.update({key: value for key, value in optional_values.items() if value is not None})

    category_id = resolve_category(project, args.category)
    if category_id:
        data["categoryId[]"] = [category_id]
    data.update(resolve_custom_fields(project, args.custom))
    if not data:
        raise ValueError("No update fields provided.")
    return data


def update_issue(config, args):
    data = build_update_payload(config, args)
    if args.dry_run:
        return {"dryRun": True, "issue": args.issue_id, "payload": data}
    return request_json(config, "PATCH", f"/issues/{args.issue_id}", data=data)


def add_common_issue_fields(parser):
    parser.add_argument("--desc", help="Issue description")
    parser.add_argument("--priority", help="Priority ID or name")
    parser.add_argument("--assignee", help="Assignee user ref from config.users or raw user ID")
    parser.add_argument("--category", help="Category ID or name from config/<PROJECT>.json")
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


def main():
    parser = argparse.ArgumentParser(
        description="Backlog API CLI. Always uses default_project_key from config/backlog.json.",
    )
    subparsers = parser.add_subparsers(dest="command")

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--query", help="Search keyword")
    list_parser.add_argument("--assignee", type=int, help="Assignee ID")
    list_parser.add_argument("--me", action="store_true", help="Filter by configured default assignee")

    create_parser = subparsers.add_parser("create")
    create_parser.add_argument("summary", help="Issue summary")
    create_parser.add_argument("--issue-type", help="Issue type ID or name")
    create_parser.add_argument("--parent", help="Parent issue key, e.g. OOP-123")
    add_common_issue_fields(create_parser)

    update_parser = subparsers.add_parser("update")
    update_parser.add_argument("issue_id", help="Issue ID or key, e.g. OOP-123")
    update_parser.add_argument("--summary", help="New summary")
    update_parser.add_argument("--status", help="Status ID or name")
    update_parser.add_argument("--comment", help="Add update comment")
    add_common_issue_fields(update_parser)

    args = parser.parse_args()
    config = load_config()

    try:
        if args.command == "list":
            me = config.get("defaults", {}).get("assignee", "me")
            a_id = resolve_user_id(config, me) if args.me else args.assignee
            result = get_issues(config, args.query, a_id)
        elif args.command == "create":
            result = create_issue(config, args)
        elif args.command == "update":
            result = update_issue(config, args)
        else:
            parser.print_help()
            return
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
