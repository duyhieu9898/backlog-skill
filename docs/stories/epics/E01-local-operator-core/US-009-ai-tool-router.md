# US-009 AI Tool Router

## Status

planned

## Lane

high-risk

## Product Contract

AI providers can interpret natural-language requests and choose only registered
tools or allowlisted commands. The model cannot bypass policy with raw shell,
raw filesystem writes, or hidden instructions from skill docs.

## Relevant Product Docs

- `plan.md`
- `skills.md`
- `docs/stories/epics/E01-local-operator-core/README.md`

## Acceptance Criteria

- Provider interface supports configured OpenAI or Gemini providers.
- Stable system prompt and tool schema are loaded from reviewed files.
- AI receives skill metadata and selected context from the Context Hydrator.
- AI responses are validated against a tool-call schema.
- Unknown tools, denied paths, denied commands, and missing confirmations are
  rejected before execution.
- At most one command/tool execution is allowed per incoming user message.
- Provider requests and responses are traced with sanitized summaries.

## Design Notes

- Commands:
  - No raw shell tool exposed to AI.
- Domain rules:
  - AI chooses intent and tool arguments.
  - Tool layer enforces authority.
  - Presenter cannot trigger additional commands.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Tool schema validation, rejected unknown tools, one-action limit. |
| Integration | Fake provider selects allowed and denied tools. |
| E2E | Telegram request routes to Bemo preview without direct command alias. |
| Platform | Provider errors return concise user-facing messages and detailed trace errors. |
| Release | Prompt and tool schema reviewed before real external writes. |

## Harness Delta

High-risk because AI can initiate local and external actions through tools.

## Evidence

No implementation proof yet.
