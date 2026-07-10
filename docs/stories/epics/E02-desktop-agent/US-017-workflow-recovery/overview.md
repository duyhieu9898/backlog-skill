# Overview

## Current Behavior

Tool calls are bounded individually but desktop multi-step workflows have no
durable state or shared recovery policy.

## Target Behavior

Desktop workflows retain a bounded step timeline, artifact references, observed
state digests, and actionable stop reasons for the user.

## Non-Goals

- No unattended multi-app automation.
- No automatic retry after an unexpected visual state.
