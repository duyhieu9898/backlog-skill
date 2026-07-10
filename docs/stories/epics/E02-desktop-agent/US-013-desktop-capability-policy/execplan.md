# Exec Plan

## Goal

Create the mandatory typed policy boundary for all future desktop actions.

## Risk Classification

Risk flags: authorization, audit/security, public workflow, weak proof.

## Work Phases

1. Complete: define adapter, app-registry, event envelope, and presenter-facing
   capability-status contracts. Artifact metadata remains owned by US-014.
2. Complete: extend the existing permission path with typed desktop action kinds
   and digest-confirmation decisions; no desktop-specific state table exists.
3. Complete for the safe baseline: add unavailable-adapter proof and `/desktop`
   status output. A reviewed Linux adapter remains the US-015 prerequisite.

## Stop Conditions

Pause if the selected OS adapter needs unrestricted shell or unclear OS
permission grants.
