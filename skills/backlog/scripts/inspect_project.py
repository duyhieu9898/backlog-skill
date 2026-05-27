#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys

import requests

from backlog_settings import CONFIG_PATH, api_base_url, load_config, load_env_file, require_api_key

load_env_file()


def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug or "custom_field"


def get_json(config, path):
    response = requests.get(
        f"{api_base_url(config)}{path}",
        params={"apiKey": require_api_key()},
    )
    response.raise_for_status()
    return response.json()


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
            "custom_fields": custom_field_config,
        },
    }


def output_path_for(project_key):
    config_dir = os.path.dirname(CONFIG_PATH)
    return os.path.join(config_dir, f"{project_key}.json")


def main():
    parser = argparse.ArgumentParser(
        description="Inspect a Backlog project and write config/<PROJECT_KEY>.json reference data.",
    )
    parser.add_argument("project_key", help="Backlog project key, e.g. AQM")
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print JSON to stdout instead of writing config/<PROJECT_KEY>.json",
    )
    args = parser.parse_args()

    try:
        project_config = build_project_config(args.project_key)
        content = json.dumps(project_config, indent=2, ensure_ascii=False) + "\n"
        if args.stdout:
            print(content, end="")
            return

        output_path = output_path_for(project_config["key"])
        with open(output_path, "w", encoding="utf-8") as output_file:
            output_file.write(content)
        print(f"Wrote {output_path}")
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
