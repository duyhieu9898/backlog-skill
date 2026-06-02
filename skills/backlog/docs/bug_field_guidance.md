# Bug Field Guidance

Use this document when selecting `qc_activity`, `bug_origin`, and `cause_category` for `scripts/bug_workflow.py resolve`.

Use labels, not IDs. The resolver maps labels to project-specific IDs from `config/projects/<PROJECT>.json`.

## QC Activity

Choose what best describes how the bug was found or validated.

- `Unit Test`: bug found or verified at unit/function level.
- `Integration Test`: bug involves interaction between modules, APIs, DB, services, or cross-component behavior.
- `SystemTest`: bug is visible in an end-to-end application flow.
- `Acceptance Test`: bug is tied to acceptance/customer scenario.
- `Code Review`: bug found by reading/reviewing code, not by runtime test.
- `Document Review`: bug found from document/spec review.
- `Not Applicable`: testing activity is unknown or not relevant.

Default for personal resolve workflow: `Integration Test`.

## Bug Origin

Choose the concrete origin/type of the bug.

- `COD_Coding Logic`: wrong condition, branching, loop, calculation, validation, or implementation logic.
- `COD_Compile`: compile/build/syntax/import/type error.
- `COD_Hard Code`: hard-coded value causes incorrect behavior.
- `COD_Coding Standard`: coding convention/standard violation.
- `COD_Redundancy Code`: redundant or duplicated code causes issue.
- `COD_Other`: coding issue where no more specific COD option fits.
- `FUN_Incomplete Function`: feature exists but implementation is incomplete or misses a case.
- `FUN_Wrong Business Logic`: implementation conflicts with business rule or expected workflow.
- `FUN_Feature Missing`: required feature or behavior is missing.
- `UI_Layout`: layout, alignment, responsive display, spacing.
- `UI_Label Message`: wrong text, label, message, translation.
- `UI_Position Size`: position or size issue.
- `DES_*`: design/spec/interface/table/data-flow related root origin.
- `DOC_*`: documentation/template/grammar issue.

Default for personal resolve workflow: `FUN_Incomplete Function`.

## Cause Category

Choose the process/root cause category.

- `REQ_Missing or incomplete`: requirement was missing/incomplete.
- `REQ_Unclear Or Ambiguous`: requirement wording caused misunderstanding.
- `DES_Missing or incomplete`: design was missing/incomplete.
- `FUN_Integration Problem`: integration between components caused the bug.
- `DEP_Environment Issue`: environment caused or exposed the bug.
- `DEP_Deployment Issue`: deployment/setup caused the bug.
- `IMP_Insufficient analysis  before implementation`: missed case due to insufficient analysis.
- `IMP_Shortage of time`: time pressure caused incomplete handling.
- `IMP_Discipline/process non-compliance`: process was skipped/not followed.
- `SKI_*`: skill or knowledge gap.
- `COM_Missing communication`: communication gap.
- `CAR_Carelessness`: simple oversight, typo, missed check, or careless implementation.
- `PRO_Missing or incomplete`: process/procedure missing or incomplete.
- `Not Applicable`: unknown, no clear process cause, or not worth classifying.

Default for personal resolve workflow: `Not Applicable`.

## Selection Rule

If confidence is low:

1. Prefer the configured default.
2. Explain the uncertainty in the dry-run summary.
3. Do not use `--apply` without user confirmation.
