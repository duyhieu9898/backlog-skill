# Context Management Refactor Plan

Date: 2026-07-17

## Purpose

Use this document as the single planning source for reducing AI input-token
cost while preserving conversational continuity. It records the supplied
OpenClaw analysis and translates only the relevant ideas into a staged plan for
`my-agent`; it does not authorize an implementation by itself.

## Problem Statement

A trivial local-CLI evaluation (`2+2`) cost 3,641 tokens despite a one-token
answer. The measured input was approximately 1,800 tokens of tool schemas,
1,000 tokens of unrelated retained chat history, and 650 tokens of system
instruction. The direct prompt and answer were negligible.

The immediate defect is session contamination: all evaluations share the
stable `local-cli` chat ID and, unless reset, the `default` session. The
current hydrator selects the latest 20 messages by count, not a token budget.
Compaction begins only after 15 messages and summarizes the first 10, so it is
not a sufficient isolation mechanism for independent evaluations.

## Current-Code Assessment (2026-07-17)

The supplied `CONCEPT_OPENCLAW_CONTEXT.md` describes the desired separation
between durable transcript and a budgeted model view. `my-agent` already has
some useful primitives, but they do not yet form that separation:

| Concern | Current behavior | Refactor implication |
| --- | --- | --- |
| CLI identity | `toCliMessage()` always uses `chatId = local-cli`; an active session falls back to `default`. | Independent evals share a conversation until `/reset`; introduce an explicit, generated eval session while preserving an opt-in stable CLI session for approval handoffs. |
| Chat persistence | `AgentRuntime.execute()` persists inbound user and final assistant text to `chat_messages`. | This is a useful conversational record, but is not a complete agent transcript. |
| Tool persistence | The loop persists each call/result to `run_steps`; in-memory `steps` and approval continuation carry them through one run. | Build a normalized context-event view or project `run_steps` into the transcript before relying on OpenClaw-style atomic tool-pair boundaries. Do not infer pairs from free-form assistant text. |
| History selection | `ContextHydrator` calls `listRecentChat(chatId, 20)`, then character-trims only entries older than the latest three. | Replace count and character rules with token-budgeted selection before provider serialization. |
| Compaction | After a successful run, an asynchronous compactor summarizes the first 10 of more than 15 active-session rows, moves them to a `:compacted` session ID, and inserts prose summary text. | It is lossy, count-based, lacks coverage/token metadata, and can race with the next request; replace it gradually with a persisted, validated checkpoint. |
| Prompt construction | The current OpenAI adapter makes history separate messages but serializes `availableTools`, runtime, skill content, prior tool steps, and current user message into one user JSON payload. Gemini uses native function declarations when tools exist. | Tool schemas are a per-call fixed cost for OpenAI's current adapter and must be attributed separately. Keep intent-scoped selection; evaluate a native tool-call adapter only as a later, provider-specific change. |
| Size limits | Dynamic context has a 24 KiB character truncation helper, but it is not the provider's token budget and is only directly exercised by tests. | Make one `ContextAssembler` the sole enforcement point using token estimates and provider usage feedback. |
| Durable memory | There is no curated cross-session memory store or retrieval path. | Defer it until session isolation, bounded assembly, and checkpoint correctness are proven. |

### Current Request Path

```text
CLI: local-cli/default
  -> Router -> AgentRuntime (persist user row)
  -> ContextHydrator (latest 20 chat rows)
  -> AgentToolLoop (all definitions for unscoped request)
  -> AiRouter -> provider adapter
  -> AgentRuntime (persist final assistant row)
  -> asynchronous count-based Compactor
```

This confirms the reported history leak and explains why the existing
compactor cannot prevent it: it acts after the request and only inside the
same shared session.

## Target Model

Keep full, append-only transcript data in SQLite, but construct a bounded
working context for each model call:

```text
stable system prompt + selected tool schemas
+ structured compaction checkpoint
+ recent raw tail selected by token budget
+ retrieved durable memory (only when relevant)
+ current user message
```

The transcript remains available for audit and recovery. It is not the model
context by default.

## Design Principles

1. Isolate independent CLI/evaluation runs before optimizing summaries.
2. Budget context in tokens, never merely in a fixed number of messages.
3. Preserve assistant tool calls and their tool results as an atomic block.
4. Prune only old, heavy tool-result payloads in the assembled view; never
   rewrite the persisted transcript.
5. Maintain a structured task checkpoint (`goal`, `progress`, `decisions`,
   `next steps`, and critical identifiers) instead of a prose-only summary.
6. Flush durable facts and decisions before compaction, then retrieve them
   selectively in future sessions.
7. Treat provider prompt caching as a cost/latency optimization, not a context
   window solution.

## Proposed Policy for a 128K Context Model

These are initial planning values and require measurement against the selected
provider:

```ts
const contextPolicy = {
  maxContextTokens: 128_000,
  reserveTokens: 20_000,
  recentTailTokens: 20_000,
  summaryMaxTokens: 6_000,
  retrievedMemoryMaxTokens: 3_000,
  toolResultSoftTrimChars: 4_000,
  keepRecentAssistantTurnsFromPruning: 3,
};
```

Trigger compaction when estimated working-context tokens exceed
`maxContextTokens - reserveTokens`. Use the provider's reported counts when
available and a deterministic local estimator otherwise.

## Refactor Plan

### Phase 0 — Evaluation Isolation and Measurement

- Add an explicit CLI/evaluation session key (for example `--session`), with a
  fresh generated ID by default for evaluation runs. Keep a deliberate stable
  session option for multi-invocation confirmation workflows.
- Stop relying on the implicit `default` session for `local-cli` evals.
- Record per-request token attribution: stable prompt, tool schemas, summary,
  raw history, retrieved memory, current message, reasoning, and completion.
- Add a reproducible `2+2` regression fixture proving an isolated run contains
  no history from unrelated evaluations.

Exit criterion: two independent CLI evaluations cannot see each other's
messages, and token attribution makes the fixed and variable costs explicit.

Compatibility decision: no silent change to the stable CLI identity for normal
interactive use. Introduce a separate evaluation mode/session selector, then
move benchmark callers to it. Existing cross-process `approve <id>` flows must
continue to target the explicitly selected stable session.

### Phase 1 — Token-Budgeted Context Assembly

- Introduce a `ContextAssembler` that reads a normalized session context view
  and produces a request-local view. Keep `ContextHydrator` focused on intent,
  debug enrichment, skill selection, and tool scope.
- Replace `listRecentChat(chatId, 20)` as the primary selection rule with a
  reverse token-budgeted tail selection.
- Include a compact structured checkpoint plus the raw tail; do not include the
  current message twice.
- Initially treat a completed run's tool steps as a single atomic context block
  derived from `run_steps`; later add typed context events if direct
  per-step replay is needed. Validate order and tool-call/tool-result pairing
  at every cut boundary.
- Make the assembler calculate a per-section budget before provider adapters
  serialize their provider-specific request shape.

Exit criterion: long and short messages consume context proportionally, and
the assembled context always stays under its configured budget.

### Phase 2 — Structured Compaction Checkpoints

- Replace the free-form compaction output with validated JSON, rendered to
  concise Markdown only at prompt assembly time.
- Persist checkpoint coverage metadata: the first retained transcript entry,
  token estimate before compaction, and compaction revision/count.
- On later compactions, update the prior checkpoint with new compacted entries
  rather than discarding earlier decisions.

Suggested schema:

```ts
interface ContextCheckpoint {
  goals: string[];
  constraints: string[];
  completed: string[];
  inProgress: string[];
  blockers: string[];
  decisions: Array<{ decision: string; rationale?: string }>;
  nextSteps: string[];
  criticalContext: string[];
  importantIdentifiers: string[];
}
```

Exit criterion: compaction is independently schema-tested and preserves the
task state required to resume work without raw early transcript entries.

Migration note: retain the existing `chat_messages` rows and current prose
summaries for audit. Do not repurpose `session_id = <id>:compacted` as the
long-term checkpoint data model; add an explicit checkpoint record and migrate
only the working-view query.

### Phase 3 — View-Only Pruning

- Soft-trim old oversized tool results to a bounded head and tail.
- If still under pressure, replace sufficiently old tool results with a clear
  marker in the working view only.
- Exempt the most recent assistant turns and incomplete tool pairs.
- Apply equivalent treatment to processed images/media, retaining artifacts on
  disk and concise model conclusions in the transcript/checkpoint.

Exit criterion: historical command, file, browser, and media payloads cannot
inflate later requests without bound, while raw records remain auditable.

### Phase 4 — Durable Memory and Retrieval

- Define a small curated durable-memory store for cross-session facts,
  preferences, and architecture decisions; daily working notes remain separate.
- Before a compaction, run a silent memory-flush step that writes only durable
  facts/decisions and returns no user-facing response.
- Retrieve a bounded set of relevant memory records by lexical search first;
  add hybrid/vector retrieval only if measurements show it is necessary.

Exit criterion: a fresh session can recover durable project decisions without
loading all notes or the old transcript.

### Phase 5 — Stable Prefix and Tool-Schema Optimization

- Maintain deterministic ordering and byte-stability for the prompt prefix to
  maximize provider cache hits.
- Continue intent-scoped tool selection; measure each tool definition's token
  cost and avoid sending tools for ordinary conversation.
- Move OpenAI from JSON-embedded `availableTools` toward the provider's native
  function/tool interface only after parity tests prove schema validation,
  confirmation, raw logging, and response parsing remain unchanged. This may
  improve caching/formatting but does not eliminate the logical context cost.
- Keep Gemini's native declarations and record their reported prompt/cache
  counts in the same attribution format.

Exit criterion: provider telemetry distinguishes logical prompt size from
cache-read tokens and tool-schema cost is observable per request.

## Existing Code to Revisit

- `agent/src/adapters/cli.ts` and `agent/src/cli.ts`: local CLI identity and
  explicit session selection.
- `agent/src/storage/repositories.ts`: active-session defaults, transcript and
  checkpoint persistence queries.
- `agent/src/context/hydrator.ts`: replace count-limited history hydration with
  context assembly.
- `agent/src/context/compactor.ts`: structured checkpoint generation and
  coverage metadata.
- `agent/src/tools/loop.ts` and `agent/src/tools/executor.ts`: atomic tool
  call/result handling and result-size metadata.
- `agent/src/brain/router.ts` and provider adapters: request token telemetry,
  stable prefix handling, and provider count ingestion.
- `agent/src/brain/providers/openai.ts`: migrate from user-JSON tool schemas
  only as a separately tested provider-adapter slice.
- `agent/src/tools/loop.ts` and `agent/src/storage/repositories.ts`: define
  how durable `run_steps` become atomic context blocks without weakening the
  existing approval-resume contract.
- `agent/test/cli.test.js`, `agent/test/commands.test.js`, and new focused
  assembler tests: protect session isolation, budget enforcement, checkpoint
  coverage, and provider request shape.

## Suggested Story Slices

1. **Context telemetry and isolated evaluation sessions** — normal risk;
   minimal behavior change, protects the immediate cost regression.
2. **Token-budgeted context assembler** — high risk; replaces the prompt input
   boundary and needs fake-provider integration proof.
3. **Typed checkpoint persistence and incremental compaction** — high risk;
   changes conversation continuity/data ownership.
4. **Run-step context blocks and view-only pruning** — high risk; must preserve
   approval continuation and tool evidence exactly.
5. **Curated durable memory and lexical retrieval** — normal risk after the
   previous slices are stable.
6. **OpenAI native-tools and prompt-cache optimization** — provider-specific;
   measure before and after rather than assuming savings.

## Validation Matrix

| Risk | Required proof |
| --- | --- |
| Eval history leak | Separate default eval invocations have distinct session IDs and zero cross-history. |
| Context budget | Generated transcript fixtures remain under the configured input budget. |
| Tool integrity | No assembled context contains an orphan tool call or result. |
| Compaction | Checkpoint validates, is incrementally updated, and enables task resumption. |
| Pruning | Persisted raw payload is unchanged; only the model view is reduced. |
| Memory | Only relevant, bounded durable records are injected across sessions. |
| Cost regression | `2+2` isolated baseline reports history near zero and tool/system costs separately. |

## Architecture Acceptance Tests

`CONCEPT_OPENCLAW_CONTEXT.md` is the acceptance reference for this refactor.
After implementation, add automated tests that verify its transferable
architectural properties against `my-agent`'s own contracts; do not merely make
`eval.js` report a lower token count.

Required scenarios:

1. **Durable transcript versus working view**: persist a long conversation,
   then prove the assembled provider request contains a bounded checkpoint and
   raw tail rather than all persisted rows. Verify the original rows remain
   retrievable.
2. **Evaluation isolation**: run two default isolated evaluations with distinct
   content and prove neither request includes the other's history. Separately
   prove an explicitly stable CLI session preserves the existing approval
   handoff across processes.
3. **Token-based tail**: use fixtures with a short-message-heavy transcript and
   one oversized message; prove selection is controlled by budget rather than a
   fixed message count.
4. **Atomic tool evidence**: construct run-step fixtures and prove no assembled
   view or compaction boundary contains a tool result without its originating
   call, or the reverse.
5. **Structured, incremental compaction**: force two compactions and validate
   checkpoint schema, coverage metadata, preservation of prior decisions, and
   a resume prompt that contains the latest checkpoint plus the raw tail.
6. **View-only pruning**: prove an old oversized tool result is soft-trimmed or
   cleared in the provider view while the durable run-step/transcript evidence
   is byte-for-byte unchanged.
7. **Durable memory**: after a session boundary, prove only a bounded relevant
   memory record is injected; unrelated and daily working notes are not loaded
   wholesale.
8. **Provider accounting**: with fake OpenAI and Gemini adapters, assert
   reported/request-estimated attribution separates system, schemas, history,
   checkpoint, memory, current input, and completion. Cache-read tokens are
   recorded separately from logical context size.

Use `eval.js` only as an end-to-end regression fixture within this suite. A
passing implementation must satisfy the above behavior even if a provider's
tokenizer or cache pricing changes.

## Source Notes

The detailed OpenClaw analysis supplied on 2026-07-17 is the research input
for this plan. Its key transferable mechanisms are token-based recent-tail
selection, structured iterative compaction, view-only tool-result pruning,
pre-compaction durable-memory flush, selective retrieval, and stable-prefix
prompt caching. OpenClaw's implementation details are reference material, not
a requirement to copy its storage format or introduce a vector database.
