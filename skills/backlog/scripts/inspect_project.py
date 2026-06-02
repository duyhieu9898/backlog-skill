#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backlog_tool.client import BacklogClient
from backlog_tool.settings import (
    PROJECTS_CONFIG_DIR,
    load_config,
    load_env_file,
    log_event,
)


def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug or "custom_field"


def get_json(config, path):
    return BacklogClient(config).request_json("GET", path)


def option_summary(items):
    return [
        {
            "id": item.get("id"),
            "name": item.get("name"),
        }
        for item in items
    ]


def custom_field_value_options(custom_field):
    items = custom_field.get("items")
    if isinstance(items, list):
        return option_summary(items)
    return []


def custom_field_entry(custom_field):
    entry = {
        "label": custom_field.get("name"),
        "field": f"customField_{custom_field.get('id')}",
    }
    options = custom_field_value_options(custom_field)
    if options:
        entry["value_options"] = options
    return entry


def build_project_config(project_key):
    config = load_config()
    project = get_json(config, f"/projects/{project_key}")
    issue_types = get_json(config, f"/projects/{project_key}/issueTypes")
    categories = get_json(config, f"/projects/{project_key}/categories")
    statuses = get_json(config, f"/projects/{project_key}/statuses")
    custom_fields = get_json(config, f"/projects/{project_key}/customFields")

    custom_field_config = {}
    for custom_field in custom_fields:
        key = slugify(custom_field.get("name") or f"custom_field_{custom_field.get('id')}")
        if key in custom_field_config:
            key = f"{key}_{custom_field.get('id')}"
        custom_field_config[key] = custom_field_entry(custom_field)

    return {
        "key": project.get("projectKey") or project_key,
        "name": project.get("name"),
        "id": project.get("id"),
        "bug": {
            "category_options": option_summary(categories),
            "issue_type_options": option_summary(issue_types),
            "status_options": option_summary(statuses),
            "custom_fields": custom_field_config,
        },
    }


def output_path_for(project_key):
    os.makedirs(PROJECTS_CONFIG_DIR, exist_ok=True)
    return os.path.join(PROJECTS_CONFIG_DIR, f"{project_key}.json")


def main():
    load_env_file()
    parser = argparse.ArgumentParser(
        description="Inspect a Backlog project and write config/projects/<PROJECT_KEY>.json reference data.",
    )
    parser.add_argument("project_key", help="Backlog project key, e.g. AQM")
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print JSON to stdout instead of writing config/projects/<PROJECT_KEY>.json",
    )
    args = parser.parse_args()
    log_event("info", "command_start", command="inspect_project", project=args.project_key, stdout=args.stdout)

    try:
        project_config = build_project_config(args.project_key)
        content = json.dumps(project_config, indent=2, ensure_ascii=False) + "\n"
        if args.stdout:
            print(content, end="")
            log_event("info", "command_end", command="inspect_project", project=args.project_key, stdout=True)
            return

        output_path = output_path_for(project_config["key"])
        with open(output_path, "w", encoding="utf-8") as output_file:
            output_file.write(content)
        print(f"Wrote {output_path}")
        log_event("info", "command_end", command="inspect_project", project=project_config["key"], output=output_path)
    except Exception as error:
        log_event("error", "command_error", command="inspect_project", project=args.project_key, error=error)
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
