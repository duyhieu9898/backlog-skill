#!/usr/bin/env python3
import re
from datetime import date, timedelta

from .bug_template import bug_context
from backlog_tool.client import BacklogClient
from backlog_tool.resolver import resolve_custom_field_defaults, resolve_status
from backlog_tool.settings import load_workflow_config, log_event, resolve_project, resolve_user_id
from .config import require_int, require_list, require_value


def issue_type_name(issue):
    return (issue.get("issueType") or {}).get("name")


def status_name(issue):
    return (issue.get("status") or {}).get("name")


def user_id(user):
    return (user or {}).get("id")


def is_open_bug_for_user(issue, assignee_id, issue_type, excluded_statuses):
    if issue_type_name(issue) != issue_type:
        return False
    if status_name(issue) in excluded_statuses:
        return False
    return user_id(issue.get("assignee")) == assignee_id


def my_open_bugs(config, project_key=None, query=None):
    workflow = load_workflow_config("resolve_bug")
    project = resolve_project(config, project_key)
    assignee_id = resolve_user_id(config, require_value(workflow, "assignee", "resolve_bug"))
    issue_type = require_value(workflow, "issue_type", "resolve_bug")
    excluded_statuses = set(require_list(workflow, "excluded_statuses", "resolve_bug"))
    client = BacklogClient(config)
    issues = client.get_issues(client.get_project_id(project), query=query, assignee_id=assignee_id)
    return [
        bug_context(issue)
        for issue in issues
        if is_open_bug_for_user(issue, assignee_id, issue_type, excluded_statuses)
    ]


def my_open_bugs_raw(config, project_key=None, query=None):
    """Like my_open_bugs but returns raw API issues (for compact_issue presenter)."""
    workflow = load_workflow_config("resolve_bug")
    project = resolve_project(config, project_key)
    assignee_id = resolve_user_id(config, require_value(workflow, "assignee", "resolve_bug"))
    issue_type = require_value(workflow, "issue_type", "resolve_bug")
    excluded_statuses = set(require_list(workflow, "excluded_statuses", "resolve_bug"))
    client = BacklogClient(config)
    issues = client.get_issues(client.get_project_id(project), query=query, assignee_id=assignee_id)
    return [
        issue
        for issue in issues
        if is_open_bug_for_user(issue, assignee_id, issue_type, excluded_statuses)
    ]


def get_bug_context(config, issue_key):
    return bug_context(BacklogClient(config).get_issue(issue_key))


def created_user_ref(issue):
    created_user = issue.get("createdUser") or {}
    created_user_id = created_user.get("id")
    if not created_user_id:
        raise ValueError("Issue is missing createdUser.id; cannot assign resolved bug to creator.")
    return int(created_user_id)


def has_value(value):
    if value is None:
        return False
    if value == "":
        return False
    if isinstance(value, (list, tuple, dict)) and not value:
        return False
    return True


def custom_field_id(field_name):
    prefix = "customField_"
    if not field_name.startswith(prefix):
        return None
    return int(field_name[len(prefix) :])


def issue_custom_field(issue, project, field_key):
    field_config = project.get("bug", {}).get("custom_fields", {}).get(field_key)
    if not field_config:
        return None
    field_id = custom_field_id(field_config["field"])
    for field in issue.get("customFields", []) or []:
        if field.get("id") == field_id:
            return field
        if field.get("name") == field_config.get("label"):
            return field
        if field.get("field") == field_config["field"]:
            return field
    return None


def issue_has_custom_value(issue, project, field_key):
    field = issue_custom_field(issue, project, field_key)
    return bool(field and has_value(field.get("value")))


def add_custom_default_if_missing(payload, issue, project, field_key, selected_value, optional=False):
    if issue_has_custom_value(issue, project, field_key):
        return
    if field_key not in project.get("bug", {}).get("custom_fields", {}):
        if optional:
            return
        available = ", ".join(sorted(project.get("bug", {}).get("custom_fields", {}).keys()))
        raise ValueError(f"Unknown custom field '{field_key}'. Available: {available}")
    payload.update(resolve_custom_field_defaults(project, {field_key: selected_value}))


def add_custom_value(payload, project, field_key, selected_value, optional=False):
    if field_key not in project.get("bug", {}).get("custom_fields", {}):
        if optional:
            return
        available = ", ".join(sorted(project.get("bug", {}).get("custom_fields", {}).keys()))
        raise ValueError(f"Unknown custom field '{field_key}'. Available: {available}")
    payload.update(resolve_custom_field_defaults(project, {field_key: selected_value}))


SUMMARY_PREFIX_PATTERN = re.compile(r"^(?:\s*\[[^\]]*\])+\s*[-:]?\s*")


def clean_summary_for_fix(summary):
    """Strip leading [bug][key][module] prefixes from a bug summary so the
    fallback Corrective Action reads like a fix description, not a title."""
    if not summary:
        return ""
    return SUMMARY_PREFIX_PATTERN.sub("", str(summary)).strip()


def corrective_action_text(issue, issue_key, fix_description=None):
    if fix_description:
        source = fix_description
    else:
        source = clean_summary_for_fix(issue.get("summary")) or issue.get("summary") or issue_key
    return f"fixed {str(source).lower()}"


def build_resolve_bug_payload(
    config,
    issue_key,
    status=None,
    actual_hours=None,
    estimated_hours=None,
    qc_activity=None,
    cause_category=None,
    bug_origin=None,
    impacted=None,
    resolution=None,
    comment=None,
    fix_description=None,
    today=None,
):
    workflow = load_workflow_config("resolve_bug")
    client = BacklogClient(config)
    issue = client.get_issue(issue_key)
    project_key = (issue.get("project") or {}).get("projectKey") or config.get("default_project_key")
    project = resolve_project(config, project_key)
    start_date = today or date.today()
    today_text = start_date.strftime("%Y-%m-%d")
    due_in_days = require_int(workflow, "due_in_days", "resolve_bug")
    due_date_text = (start_date + timedelta(days=due_in_days)).strftime("%Y-%m-%d")
    status = status or require_value(workflow, "status", "resolve_bug")
    qc_activity = qc_activity or require_value(workflow, "qc_activity", "resolve_bug")
    cause_category = cause_category or require_value(workflow, "cause_category", "resolve_bug")
    bug_origin = bug_origin or require_value(workflow, "bug_origin", "resolve_bug")
    impacted = impacted or require_value(workflow, "impacted", "resolve_bug")
    resolution = resolution or require_value(workflow, "resolution", "resolve_bug")

    if issue_type_name(issue) != require_value(workflow, "issue_type", "resolve_bug"):
        raise ValueError(f"{issue_key} is not a Bug issue.")

    payload = {
        "statusId": resolve_status(project, status),
        "assigneeId": created_user_ref(issue),
    }
    if not issue.get("startDate"):
        payload["startDate"] = today_text
    if not issue.get("dueDate"):
        payload["dueDate"] = due_date_text
    if issue.get("estimatedHours") is None and estimated_hours is not None:
        payload["estimatedHours"] = estimated_hours
    elif issue.get("estimatedHours") is None:
        payload["estimatedHours"] = require_value(workflow, "estimated_hours", "resolve_bug")
    if issue.get("actualHours") is None and actual_hours is not None:
        payload["actualHours"] = actual_hours
    elif issue.get("actualHours") is None:
        payload["actualHours"] = require_value(workflow, "actual_hours", "resolve_bug")
    if comment:
        payload["comment"] = comment

    add_custom_default_if_missing(payload, issue, project, "qc_activity", qc_activity)
    add_custom_default_if_missing(payload, issue, project, "cause_category", cause_category)
    add_custom_default_if_missing(payload, issue, project, "bug_origin", bug_origin)
    add_custom_value(payload, project, "impacted", impacted)
    add_custom_value(payload, project, "corrective_action", corrective_action_text(issue, issue_key, fix_description))
    add_custom_default_if_missing(payload, issue, project, "resolution", resolution, optional=True)
    warnings = []
    if not fix_description:
        warnings.append(
            "corrective_action fell back to the issue summary; pass --fix-description for an accurate fix note."
        )

    built = {
        "issue": issue_key,
        "project": project["key"],
        "payload": payload,
        "context": bug_context(issue),
    }
    built["changes"] = summarize_changes(issue, project, payload)
    built["warnings"] = warnings
    return built


CORE_FIELD_LABELS = {
    "statusId": "Status",
    "assigneeId": "Assignee",
    "startDate": "Start Date",
    "dueDate": "Due Date",
    "estimatedHours": "Estimated Hours",
    "actualHours": "Actual Hours",
    "comment": "Comment",
}


def custom_field_label_map(project):
    labels = {}
    for field_config in project.get("bug", {}).get("custom_fields", {}).values():
        labels[field_config["field"]] = field_config.get("label") or field_config["field"]
    return labels


def custom_field_current_value(issue, field_id):
    for field in issue.get("customFields", []) or []:
        if field.get("id") == field_id:
            value = field.get("value")
            if isinstance(value, dict):
                return value.get("name")
            if isinstance(value, list):
                return ", ".join(str((item or {}).get("name", item)) for item in value)
            return value
    return None


def summarize_changes(issue, project, payload):
    """Human-readable list of fields this resolve will write. Keeps the agent
    from re-reading the full issue context just to verify the diff."""
    labels = custom_field_label_map(project)
    changes = []
    for key, value in payload.items():
        if key in CORE_FIELD_LABELS:
            changes.append({"field": CORE_FIELD_LABELS[key], "key": key, "value": value})
        elif key.startswith("customField_"):
            field_id = custom_field_id(key)
            changes.append(
                {
                    "field": labels.get(key, key),
                    "key": key,
                    "from": custom_field_current_value(issue, field_id),
                    "value": value,
                }
            )
        else:
            changes.append({"field": key, "key": key, "value": value})
    return changes


def resolve_bug(config, issue_key, dry_run=True, **kwargs):
    built = build_resolve_bug_payload(config, issue_key, **kwargs)
    if dry_run:
        log_event(
            "info",
            "dry_run",
            command="bug_resolve",
            issue=issue_key,
            project=built["project"],
            payload_keys=",".join(sorted(built["payload"].keys())),
        )
        return {"dryRun": True, **built}
    return BacklogClient(config).update_issue(issue_key, built["payload"])