# Exec Plan

## Goal

Create the mandatory typed policy boundary for all future desktop actions.

## Risk Classification

Risk flags: authorization, audit/security, public workflow, weak proof.

## Work Phases

1. Define adapter, app-registry, artifact metadata, event, and presenter contracts.
2. Extend the existing permission and digest-confirmation paths with desktop action kinds.
3. Add fake-adapter proof and capability status output for the Linux initial target.

## Stop Conditions

Pause if the selected OS adapter needs unrestricted shell or unclear OS
permission grants.
