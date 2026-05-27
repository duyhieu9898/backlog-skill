#!/usr/bin/env python3
import json
import os
import tempfile
from copy import deepcopy

SKILL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONFIG_PATH = os.path.join(SKILL_DIR, "config", "backlog.json")
ENV_PATH = os.path.join(SKILL_DIR, ".env")


def load_env_file():
    if not os.path.exists(ENV_PATH):
        return
    with open(ENV_PATH, "r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as config_file:
        config = json.load(config_file)
    validate_config(config)
    return config


def save_config(config):
    validate_config(config)
    config_dir = os.path.dirname(CONFIG_PATH)
    os.makedirs(config_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="backlog.", suffix=".json", dir=config_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp_file:
            json.dump(config, tmp_file, indent=2, ensure_ascii=False)
            tmp_file.write("\n")
        os.replace(tmp_path, CONFIG_PATH)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def validate_config(config):
    if not config.get("base_url"):
        raise ValueError("Missing config.base_url")
    if not config.get("default_project_key"):
        raise ValueError("Missing config.default_project_key")
    if not isinstance(config.get("projects"), list) or not config["projects"]:
        raise ValueError("Missing config.projects list")
    project_keys = set(config["projects"])
    if config["default_project_key"] not in project_keys:
        raise ValueError("default_project_key must exist in projects")


def api_base_url(config):
    return config["base_url"].rstrip("/") + "/api/v2"


def view_base_url(config):
    return config["base_url"].rstrip("/")


def catalog_path(project_key):
    return os.path.join(SKILL_DIR, "config", f"{project_key}.json")


def load_project_catalog(project_key):
    path = catalog_path(project_key)
    if not os.path.exists(path):
        raise ValueError(f"Missing project catalog {path}. Run: python3 scripts/inspect_project.py {project_key}")
    with open(path, "r", encoding="utf-8") as catalog_file:
        return json.load(catalog_file)


def project_keys(config):
    return list(config["projects"])


def resolve_project_key(config, project_key=None):
    key = project_key or config["default_project_key"]
    if key not in project_keys(config):
        keys = ", ".join(sorted(project_keys(config)))
        raise ValueError(f"Unknown Backlog project '{key}'. Available projects: {keys}")
    return key


def resolve_project(config, project_key=None):
    key = resolve_project_key(config, project_key)
    return deepcopy(load_project_catalog(key))


def resolve_user_id(config, user_ref):
    if isinstance(user_ref, int):
        return user_ref
    user = config.get("users", {}).get(str(user_ref))
    if not user or "id" not in user:
        raise ValueError(f"Unknown Backlog user reference '{user_ref}'")
    return int(user["id"])


def require_api_key():
    api_key = os.environ.get("BACKLOG_API_KEY", "")
    if not api_key:
        raise Exception("Missing BACKLOG_API_KEY. Set it in the environment or create .env from .env.example.")
    return api_key
