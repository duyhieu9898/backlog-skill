# US-009 Overview

## Goal

Let AI providers choose safe local actions through registered tools without
giving them raw shell, unrestricted file access, or skill-specific core router
branches.

## Scope

- Generic AI tool loop.
- Registered file tools and allowlisted command tools.
- JSON-stdin command input with schema validation.
- Bounded multi-step planning before confirmation.
- Exact confirmation for the first side-effecting action.

## Non-Goals

- No raw shell tool.
- No provider access to secrets.
- No automatic continuation after a confirmed side effect.
- No Bemo-specific orchestration in `agent/src/core/router.ts`.

## Current State

Implemented in code and covered by unit/integration tests. Telegram/provider
smoke remains before marking the story implemented.
