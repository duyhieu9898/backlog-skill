# Bug Workflow

Use this document when the user asks to get bug context, analyze a bug for fixing, list bugs assigned to them, or resolve a bug.

## Commands

```bash
python3 scripts/bug_workflow.py my-open --project AQM
python3 scripts/bug_workflow.py context AQM-123
python3 scripts/bug_workflow.py resolve AQM-123 --actual-hours 1.5 --fix-description "Save issue" --comment "Fixed save issue"
python3 scripts/bug_workflow.py resolve AQM-123 --actual-hours 1.5 --apply
```

`resolve` is dry-run by default. Only use `--apply` after the dry-run payload is correct.

## Bug Context

`context` parses issue description into:

```markdown
**Environment**:

**Pre-Condition**:
-

**Steps to reproduce**:
1.
2.

**Actual**:

**Expected**:

 **Evidence**:
```

The parser also accepts imperfect headings such as `**Actual:` or `**Actual:**`, because tester/QC edits can remove one side of the markdown bold marker.

The output includes:

- `description`: deterministic parsed sections.
- `descriptionMeta.hasTemplateMarkers`: whether known section markers were found.
- `descriptionMeta.presentSections`: sections with values.
- `descriptionMeta.missingSections`: sections without values.
- `rawDescription`: original Backlog description.

If `hasTemplateMarkers=false` or important sections are missing, use `rawDescription` plus the parsed result for AI fallback analysis. Do not invent facts that are not in the issue.

## Resolve Bug Rule

The personal resolve workflow:

- Applies only to issue type `Bug`.
- Sets status to `Resolved` by default.
- Assigns the issue back to `createdUser`.
- Sets missing `startDate` to today.
- Sets missing `dueDate` to `startDate + 2 days`.
- Sets missing `estimatedHours` to the user value, or `1` when user does not provide one.
- Sets missing `actualHours` to the user value, or `1` when user does not provide one.
- Uses dry-run by default.

Custom field behavior:

- `impacted` is always overwritten.
- `corrective_action` is always overwritten.
- Other custom fields are only set when the issue currently has no value.

Default custom field values:

- `qc_activity=Integration Test`
- `cause_category=Not Applicable`
- `bug_origin=FUN_Incomplete Function`
- `impacted=no`
- `corrective_action=fixed <fix description lowercased>`, falling back to issue summary when `--fix-description` is not provided.
- `resolution=fixed` when the project has a `resolution` custom field.

Override custom field values with:

```bash
--qc-activity "Unit Test"
--cause-category "CAR_Carelessness"
--bug-origin "COD_Coding Logic"
--fix-description "Validate required field"
```

## Agent Flow

1. Run `context <ISSUE_KEY>` to inspect the bug.
2. Read `docs/bug_field_guidance.md` before choosing `qc_activity`, `bug_origin`, or `cause_category`.
3. Build a resolve dry-run command with actual hours/comment and selected field values.
4. Review `statusId`, `assigneeId`, dates, hours, and `customField_*` values.
5. Use `--apply` only after the payload is correct or user explicitly approves.
