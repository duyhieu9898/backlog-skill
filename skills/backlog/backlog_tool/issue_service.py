#!/usr/bin/env python3
from .client import BacklogClient
from .resolver import (
    find_option,
    resolve_assignee,
    resolve_category,
    resolve_custom_fields,
    resolve_issue_type,
)
from .settings import log_event, resolve_project


def request_json(config, method, path, data=None):
    return BacklogClient(config).request_json(method, path, data=data)


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


def get_issue(config, issue_id):
    return BacklogClient(config).get_issue(issue_id)


def get_issues(config, project_key=None, query=None, assignee_id=None):
    project = resolve_project(config, project_key)
    client = BacklogClient(config)
    return client.get_issues(client.get_project_id(project), query=query, assignee_id=assignee_id)


def build_create_payload(config, args):
    project = resolve_project(config, args.project)
    defaults = config.get("defaults", {})
    issue_type = args.issue_type
    if issue_type is None:
        raise ValueError("--issue-type is required for generic create. Use workflow scripts for business defaults.")
    priority = args.priority or defaults.get("priority_id", 3)
    assignee = args.assignee or defaults.get("assignee")
    client = BacklogClient(config)

    data = {
        "projectId": client.get_project_id(project),
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
        log_event("info", "dry_run", command="create", project=args.project, payload_keys=",".join(sorted(data.keys())))
        return {"dryRun": True, "payload": data}
    return BacklogClient(config).create_issue(data)


def build_update_payload(config, args):
    project = resolve_project(config, args.project)
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
        log_event(
            "info",
            "dry_run",
            command="update",
            project=args.project,
            issue=args.issue_id,
            payload_keys=",".join(sorted(data.keys())),
        )
        return {"dryRun": True, "issue": args.issue_id, "payload": data}
    return BacklogClient(config).update_issue(args.issue_id, data)
