#!/usr/bin/env python3
import argparse
import json
import sys

from backlog_settings import load_config, load_project_catalog, project_keys, save_config


def print_projects(config):
    default_key = config["default_project_key"]
    for project_key in project_keys(config):
        marker = "*" if project_key == default_key else " "
        try:
            catalog = load_project_catalog(project_key)
            project_id = catalog.get("id", "-")
            name = catalog.get("name", "")
        except Exception:
            project_id = "-"
            name = "(missing catalog)"
        print(f"{marker} {project_key} id={project_id} name={name}")


def set_default(project_key):
    config = load_config()
    if project_key not in project_keys(config):
        keys = ", ".join(sorted(project_keys(config)))
        raise ValueError(f"Unknown project '{project_key}'. Available projects: {keys}")
    config["default_project_key"] = project_key
    save_config(config)
    print(f"Default Backlog project set to {project_key}")


def main():
    parser = argparse.ArgumentParser(description="Manage Backlog skill config.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list-projects", help="List configured projects")
    subparsers.add_parser("current", help="Print current default project")

    set_parser = subparsers.add_parser("set-default", help="Set default project and write config file")
    set_parser.add_argument("project_key", help="Project key from config/backlog.json")

    subparsers.add_parser("show", help="Print full config JSON")

    args = parser.parse_args()
    config = load_config()

    if args.command == "list-projects":
        print_projects(config)
    elif args.command == "current":
        print(config["default_project_key"])
    elif args.command == "set-default":
        set_default(args.project_key)
    elif args.command == "show":
        print(json.dumps(config, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
