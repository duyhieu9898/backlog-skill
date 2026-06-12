#!/usr/bin/env python3
"""Machine-readable bug workflow rules and field guidance.

This replaces long prose docs: the agent runs `backlog.py bug rules` or
`backlog.py bug fields <field>` to load only the logic it needs, instead of
reading multiple markdown files into context.
"""

from .config import require_int, require_value
from backlog_tool.settings import load_workflow_config


def resolve_rules():
    """Return the personal resolve-bug rule as structured data, sourced from
    config so it never drifts from actual behavior."""
    workflow = load_workflow_config("resolve_bug")
    return {
        "appliesTo": f"issue type '{require_value(workflow, 'issue_type', 'resolve_bug')}' assigned to me",
        "actions": [
            f"Set status to '{require_value(workflow, 'status', 'resolve_bug')}'.",
            "Assign the issue back to createdUser (the reporter).",
            "Set startDate to today if missing.",
            f"Set dueDate to startDate + {require_int(workflow, 'due_in_days', 'resolve_bug')} days if missing.",
            f"Set estimatedHours to --estimated-hours, else {require_value(workflow, 'estimated_hours', 'resolve_bug')} if missing.",
            f"Set actualHours to --actual-hours, else {require_value(workflow, 'actual_hours', 'resolve_bug')} if missing.",
        ],
        "alwaysOverwrite": ["impacted", "corrective_action"],
        "onlyWhenEmpty": ["qc_activity", "cause_category", "bug_origin", "resolution"],
        "doNotChange": ["Detected Role", "Summary", "Description", "QC Activity (if already set)"],
        "defaults": {
            "qc_activity": require_value(workflow, "qc_activity", "resolve_bug"),
            "cause_category": require_value(workflow, "cause_category", "resolve_bug"),
            "bug_origin": require_value(workflow, "bug_origin", "resolve_bug"),
            "impacted": require_value(workflow, "impacted", "resolve_bug"),
            "resolution": require_value(workflow, "resolution", "resolve_bug"),
            "corrective_action": "fixed <--fix-description lowercased>, else fixed <summary without [..] prefix>",
        },
        "overrides": {
            "--fix-description": "Text for Corrective Action (fixed <text>). Strongly recommended.",
            "--qc-activity": "Override QC Activity label.",
            "--bug-origin": "Override Bug Origin label.",
            "--cause-category": "Override Cause Category label.",
            "--estimated-hours / --actual-hours": "Numeric hours.",
            "--comment": "Update comment.",
        },
        "safety": [
            "resolve is dry-run by default; add --apply only after the diff is correct.",
            "If Detected Role is not Tester, say so in the summary before applying.",
            "Run `fields <field>` before choosing qc_activity, bug_origin, or cause_category.",
        ],
    }


# Compact field guidance. Labels must match project catalog value_options.
FIELD_GUIDANCE = {
    "qc_activity": {
        "summary": "How the bug was found or validated.",
        "default": "Integration Test",
        "options": {
            "Unit Test": "found/verified at unit or function level.",
            "Integration Test": "interaction between modules, APIs, DB, services, or cross-component.",
            "SystemTest": "visible in an end-to-end application flow.",
            "Acceptance Test": "tied to acceptance/customer scenario.",
            "Code Review": "found by reading code, not runtime test.",
            "Document Review": "found from document/spec review.",
            "Not Applicable": "testing activity unknown or not relevant.",
        },
    },
    "bug_origin": {
        "summary": "Concrete origin/type of the bug.",
        "default": "FUN_Incomplete Function",
        "options": {
            "COD_Coding Logic": "wrong condition, branching, loop, calculation, validation, or logic.",
            "COD_Compile": "compile/build/syntax/import/type error.",
            "COD_Hard Code": "hard-coded value causes wrong behavior.",
            "COD_Coding Standard": "coding convention/standard violation.",
            "COD_Redundancy Code": "redundant or duplicated code causes issue.",
            "COD_Other": "coding issue where no more specific COD option fits.",
            "FUN_Incomplete Function": "feature exists but implementation incomplete or misses a case.",
            "FUN_Wrong Business Logic": "conflicts with business rule or expected workflow.",
            "FUN_Feature Missing": "required feature or behavior is missing.",
            "UI_Layout": "layout, alignment, responsive display, spacing.",
            "UI_Label Message": "wrong text, label, message, translation.",
            "UI_Position Size": "position or size issue.",
            "DES_*": "design/spec/interface/table/data-flow related origin.",
            "DOC_*": "documentation/template/grammar issue.",
        },
    },
    "cause_category": {
        "summary": "Process/root cause category.",
        "default": "Not Applicable",
        "options": {
            "REQ_Missing or incomplete": "requirement missing/incomplete.",
            "REQ_Unclear Or Ambiguous": "requirement wording caused misunderstanding.",
            "DES_Missing or incomplete": "design missing/incomplete.",
            "FUN_Integration Problem": "integration between components caused the bug.",
            "DEP_Environment Issue": "environment caused or exposed the bug.",
            "DEP_Deployment Issue": "deployment/setup caused the bug.",
            "IMP_Insufficient analysis  before implementation": "missed case due to insufficient analysis.",
            "IMP_Shortage of time": "time pressure caused incomplete handling.",
            "IMP_Discipline/process non-compliance": "process skipped/not followed.",
            "SKI_*": "skill or knowledge gap.",
            "COM_Missing communication": "communication gap.",
            "CAR_Carelessness": "simple oversight, typo, missed check.",
            "PRO_Missing or incomplete": "process/procedure missing or incomplete.",
            "Not Applicable": "unknown or no clear process cause.",
        },
    },
}


def field_guidance(field=None):
    if field is None:
        return {
            "fields": list(FIELD_GUIDANCE.keys()),
            "hint": "Run `backlog.py bug fields <field>` for option details.",
        }
    if field not in FIELD_GUIDANCE:
        available = ", ".join(FIELD_GUIDANCE.keys())
        raise ValueError(f"Unknown field '{field}'. Available: {available}")
    return {"field": field, **FIELD_GUIDANCE[field]}
