# Exec Plan

## Goal

Make desktop actions diagnosable and safely recoverable after real prompt
trials.

## Risk Classification

Risk flags: data retention, audit/security, multi-domain, weak proof.

## Work Phases

1. Define workflow state and recovery rules.
2. Persist minimal metadata and link artifacts/traces.
3. Execute prompt-trial checklist and create follow-up stories from evidence.

## Stop Conditions

Pause if recovery would repeat an external or UI action without a new exact
observation and confirmation.
