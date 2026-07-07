# US-009 AI Tool Router

## Status

in_progress

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
- AI may compose bounded read-only/non-confirmed tool calls before a confirmed
  effect.
- The loop stops after at most four tool steps and always pauses before the
  first command or file mutation requiring confirmation.
- After confirmation, the agent executes exactly the approved tool call and does
  not auto-resume further AI planning.
- Provider requests and responses are traced with sanitized summaries.

## Design Notes

- Commands:
  - No raw shell tool exposed to AI.
  - Allowlisted commands may declare JSON-stdin input schemas.
- Domain rules:
  - AI chooses intent and tool arguments.
  - Tool layer enforces authority.
  - Presenter cannot trigger additional commands.
  - Skill-specific behavior belongs in skill commands and schemas, not core
    router branches.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Tool schema validation, rejected unknown tools, bounded loop, confirmation pause. |
| Integration | Fake provider composes JSON-stdin prepare command into confirmed create preview. |
| E2E | Telegram request routes to Bemo preview without direct command alias. |
| Platform | Provider errors return concise user-facing messages and detailed trace errors. |
| Release | Prompt and tool schema reviewed before real external writes. |

## Harness Delta

High-risk because AI can initiate local and external actions through tools.

## Evidence

- Implemented generic `AgentToolLoop` and `ToolExecutor` for registered file
  tools and allowlisted command tools.
- Provider contract now validates exactly one structured outcome:
  `text`, `clarification`, or `toolCall`.
- Command catalog supports `inputMode: "json-stdin"` plus JSON schema
  validation; structured input is sent over stdin, not shell or argv.
- Confirmation stores the exact approved AI tool call and preview digest.
- `cd agent && npm test` passes 42/42, including unknown tool rejection,
  JSON-stdin input validation, read-only prepare followed by confirmed create
  preview, and exact confirmed execution.
- Installed `my-agent` service restarted successfully after rebuild and entered
  Telegram polling with the generic tool loop build.
- Remaining proof: real Telegram natural-language smoke with configured AI
  provider and no confirmed external write.
