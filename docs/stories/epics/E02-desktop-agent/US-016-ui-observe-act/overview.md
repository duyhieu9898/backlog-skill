# Overview

## Current Behavior

The agent can capture or launch but cannot inspect or manipulate app UI.

## Target Behavior

The agent can inspect stable UI targets and execute bounded click/type/key
actions, stopping instead of guessing when a target is ambiguous.

## Non-Goals

- No free-form coordinate clicking from model output.
- No invisible background control or autonomous loops.
