#!/usr/bin/env python3
import sys
import argparse
import requests
from datetime import datetime, timedelta

from backlog_settings import (
    api_base_url,
    load_config,
    load_env_file,
    require_api_key,
    resolve_project,
    resolve_user_id,
    view_base_url,
)

load_env_file()


def require_bug_config(project):
    return project.get("bug") or {}


def get_project_id(config, project):
    if project.get("id"):
        return project["id"]
    resp = requests.get(
        f"{api_base_url(config)}/projects/{project['key']}",
        params={"apiKey": require_api_key()},
    )
    resp.raise_for_status()
    return resp.json()["id"]


def build_custom_field_payload(custom_fields):
    payload = {}
    for name, config in custom_fields.items():
        if name.startswith("_"):
            continue
        if isinstance(config, dict):
            field = config.get("field")
            if not field:
                raise ValueError(f"Custom field '{name}' missing field")
            if config.get("value") is not None:
                payload[field] = config.get("value")
        else:
            # Backward compatibility for the old {"customField_123": value} shape.
            if config is not None:
                payload[name] = config
    return payload


def find_option(options, selected, label):
    if selected is None:
        return None
    for option in options:
        if option.get("id") == selected or option.get("name") == selected:
            return option.get("id")
    available = ", ".join(str(option.get("name")) for option in options)
    raise ValueError(f"Unknown {label} '{selected}'. Available: {available}")


def merge_bug_defaults(config, project_key):
    merged = dict(config.get("bug_defaults", {}))
    override = config.get("project_overrides", {}).get(project_key, {}).get("bug_defaults", {})
    merged.update(override)
    merged["custom_fields"] = {
        **config.get("bug_defaults", {}).get("custom_fields", {}),
        **override.get("custom_fields", {}),
    }
    return merged


def resolve_custom_field_value(field_config, selected_value):
    if selected_value is None:
        return None
    options = field_config.get("value_options", [])
    if not options:
        return selected_value
    return find_option(options, selected_value, field_config.get("label") or field_config.get("field"))


def build_custom_field_payload_from_catalog(catalog, selections):
    payload = {}
    fields = catalog.get("bug", {}).get("custom_fields", {})
    for field_key, selected_value in selections.items():
        field_config = fields.get(field_key)
        if not field_config:
            continue
        value = resolve_custom_field_value(field_config, selected_value)
        if value is not None:
            payload[field_config["field"]] = value
    return payload


def create_subtask_bug(config, project_key, parent_key, module, description):
    project = resolve_project(config, project_key)
    project_key = project["key"]
    bug = require_bug_config(project)
    bug_defaults = merge_bug_defaults(config, project_key)
    defaults = config.get("defaults", {})
    assignee_id = resolve_user_id(config, defaults.get("assignee", "me"))

    # 1. Get Parent Issue ID
    resp = requests.get(
        f"{api_base_url(config)}/issues/{parent_key}",
        params={"apiKey": require_api_key()},
    )
    resp.raise_for_status()
    parent_issue = resp.json()
    parent_id = parent_issue["id"]

    # 2. Prepare Data based on Rules
    today = datetime.now()
    due_date = today + timedelta(days=int(bug_defaults.get("due_in_days", 2)))
    
    # Format Summary: [Parent Key][Module] Issue Description
    summary = f"[{parent_key}][{module}] {description}"
    
    # Corrective Action: Guess from description (lowercase)
    corrective_action = f"fixed {description.lower()}"
    corrective_action_template = bug_defaults.get("corrective_action")
    if corrective_action_template:
        corrective_action = corrective_action_template.format(
            description=description,
            description_lower=description.lower(),
        )

    issue_type_id = find_option(
        bug.get("_issue_type_options", []),
        bug_defaults.get("issue_type"),
        "issue type",
    )
    if not issue_type_id:
        raise ValueError(f"Missing issue_type in bug_defaults for project {project_key}")
    category_id = find_option(
        bug.get("_category_options", []),
        bug_defaults.get("category"),
        "category",
    )

    data = {
        "projectId": get_project_id(config, project),
        "summary": summary,
        "parentIssueId": parent_id,
        "issueTypeId": issue_type_id,
        "priorityId": defaults.get("priority_id", 3),
        "assigneeId": assignee_id,
        "startDate": today.strftime("%Y-%m-%d"),
        "dueDate": due_date.strftime("%Y-%m-%d"),
        "estimatedHours": bug_defaults.get("estimated_hours", 1),
    }
    if category_id:
        data["categoryId[]"] = [category_id]
    data.update(build_custom_field_payload_from_catalog(project, bug_defaults.get("custom_fields", {})))

    corrective_action_config = bug.get("custom_fields", {}).get("corrective_action")
    if corrective_action_config:
        data[corrective_action_config["field"]] = corrective_action

    resp = requests.post(f"{api_base_url(config)}/issues", params={"apiKey": require_api_key()}, data=data)
    resp.raise_for_status()
    return resp.json()

def main():
    parser = argparse.ArgumentParser(description="Create a Backlog sub-task bug based on HieuND's rules.")
    parser.add_argument("--project", help="Project key from config/backlog.json. Uses default_project_key when omitted.")
    parser.add_argument("parent_key", help="Parent Issue Key (e.g., OOP-10233)")
    parser.add_argument("module", help="Module Name (e.g., A020100|FE)")
    parser.add_argument("description", help="Issue Description")

    args = parser.parse_args()
    config = load_config()

    try:
        issue = create_subtask_bug(config, args.project, args.parent_key, args.module, args.description)
        print(f"Successfully created bug: {issue['issueKey']}")
        print(f"Link: {view_base_url(config)}/view/{issue['issueKey']}")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
