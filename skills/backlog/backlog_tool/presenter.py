#!/usr/bin/env python3
"""Compact presenters shared by every CLI command.

Default output is trimmed to the fields needed to triage/act, which is the main
token-cost lever. Pass --json-full at the CLI to bypass this and get raw JSON.
"""
import re

from backlog_tool.settings import load_config


def _base_url():
    """Get base_url from config for building attachment URLs."""
    try:
        config = load_config()
        return config.get("base_url", "")
    except Exception:
        return ""


def _attachment_url(attachment_id):
    """Build a full attachment image URL."""
    base = _base_url()
    return f"{base}/ViewAttachmentImage.action?attachmentId={attachment_id}"


def _build_attachment_map(attachments):
    """Map filename -> full URL from attachments list."""
    mapping = {}
    for att in attachments or []:
        name = att.get("name")
        att_id = att.get("id")
        if name and att_id:
            mapping[name] = _attachment_url(att_id)
    return mapping


def _replace_evidence_urls(description, attachments):
    """Replace ![image][filename] references in description with full URLs."""
    if not description or not attachments:
        return description
    mapping = _build_attachment_map(attachments)
    if not mapping:
        return description

    def replacer(match):
        filename = match.group(1)
        url = mapping.get(filename)
        if url:
            return url
        return match.group(0)

    # Pattern: ![image][filename] or ![alt][filename]
    return re.sub(r"!\[[^\]]*\]\[([^\]]+)\]", replacer, description)


def user_name(user):
    return (user or {}).get("name") if user else None


def compact_custom_value(value):
    if isinstance(value, dict):
        return value.get("name")
    if isinstance(value, list):
        return [(v or {}).get("name", v) if isinstance(v, dict) else v for v in value]
    return value


def compact_custom_fields(custom_fields):
    """Only include custom fields that have a meaningful value."""
    result = []
    for field in custom_fields or []:
        value = compact_custom_value(field.get("value"))
        if _has_value(value):
            result.append({"name": field.get("name"), "value": value})
    return result


def _has_value(value):
    """Check if a custom field value is meaningful (not null/empty/'-')."""
    if value is None:
        return False
    if value == "-":
        return False
    if isinstance(value, str) and not value.strip():
        return False
    if isinstance(value, list) and not value:
        return False
    return True


def compact_issue(issue):
    """Trim a raw Backlog issue (get/create/update/apply response)."""
    if not isinstance(issue, dict):
        return issue
    description = issue.get("description")
    attachments = issue.get("attachments")
    if description and attachments:
        description = _replace_evidence_urls(description, attachments)
    fields = {
        "issueKey": issue.get("issueKey"),
        "summary": issue.get("summary"),
        "description": description,
        "issueType": (issue.get("issueType") or {}).get("name"),
        "status": (issue.get("status") or {}).get("name"),
        "assignee": user_name(issue.get("assignee")),
        "priority": (issue.get("priority") or {}).get("name"),
        "startDate": issue.get("startDate"),
        "dueDate": issue.get("dueDate"),
        "estimatedHours": issue.get("estimatedHours"),
        "actualHours": issue.get("actualHours"),
    }
    custom = compact_custom_fields(issue.get("customFields"))
    # Drop fields with no value to reduce noise
    result = {k: v for k, v in fields.items() if v is not None}
    if custom:
        result["customFields"] = custom
    return result
