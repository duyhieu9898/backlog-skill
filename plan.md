# Implementation Plan: AI Agent Orchestrator

## 1. Current Direction

Mục tiêu là xây một `agent/` TypeScript đóng vai trò orchestrator qua Telegram. Các automation hiện có sẽ được gom vào `skills/` nhưng vẫn độc lập, không bị ép migrate thành source code của agent.

Target structure:

```text
my-agents/
├── agent/                 # Node.js + TypeScript orchestrator
│   ├── src/
│   │   ├── adapters/      # Telegram <-> StandardMessage
│   │   ├── brain/         # AI routing, prompt, tool selection
│   │   ├── core/          # Router, orchestrator, command handling
│   │   ├── context/       # Rule-based context hydration before AI calls
│   │   ├── logging/       # Logger + traceId
│   │   ├── skills/        # Skill registry/loader only, not skill implementations
│   │   ├── telegram/      # Telegram config/client
│   │   └── types/         # Shared interfaces
│   ├── commands.json      # Command shortcuts, aliases, confirmation, cwd
│   └── package.json
├── skills/
│   ├── bemo/              # Existing Bemo project
│   │   ├── SKILL.md
│   │   ├── package.json
│   │   └── scripts/
│   ├── gmail/
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── linux-janitor/
│   │   ├── SKILL.md
│   │   └── scripts/
│   └── backlog/
│       ├── SKILL.md
│       └── scripts/
├── skills.md              # Contract for SKILL.md format
└── plan.md
```

Key decision: `agent/src/skills/` chỉ chứa code để scan/load/route skill. Skill thật nằm ở `skills/<slug>/`.

## 2. Tech Stack

- Runtime: Node.js + TypeScript.
- Messaging: Telegram polling first, webhook later if needed.
- Telegram long replies should be split into chunks around 3500 characters.
- AI provider: OpenAI API and Gemini API behind a provider interface, configured as an object with a `default` provider field.
- AI SDKs: use official provider SDKs unless a specific blocker appears.
- Config: use `agent/config.json` for provider/model/runtime settings and `.env` only for secrets/API keys.
- System prompt: store in `agent/prompts/system.md`.
- Prompt caching: keep stable system/tool/skill metadata prefixes cacheable to reduce repeated input-token cost.
- Routing stages:
  - Command aliases from `commands.json` bypass AI.
  - Skill metadata is loaded from `skills/*/SKILL.md`.
  - Rule-based context hydration chooses memory/skill/run context before AI.
  - AI tool/function routing may choose only allowed commands.
- Storage:
  - SQLite at `agent/data/agent.sqlite` for Telegram offset, chat history, trace events, command runs, pending confirmations, and last-error/debug state.
  - SQLite package: `better-sqlite3`.
- Logging:
  - Structured JSON logs.
  - Every incoming message gets a `traceId`.
  - Runtime status/debug commands must be available before AI integration.

## 3. Skill Model

Each skill is a standalone folder:

```text
skills/<slug>/SKILL.md
```

Minimum metadata:

```ts
type SkillMetadata = {
  slug: string;
  name: string;
  description: string;
  baseDir: string;
  skillPath: string;
};
```

Command shortcut model:

```ts
type CommandShortcut = {
  name: string;
  label: string;
  skillSlug: string;
  aliases?: string[];
  cwd: string;
  argv: [string, ...string[]];
  requiresConfirmation?: boolean;
  externalSideEffect?: boolean;
  timeoutMs?: number;
};
```

A catalog entry lives in `agent/commands.json`, not inside each skill. `SKILL.md` is for AI understanding; `commands.json` is the command catalog.

Default command policy:

- `requiresConfirmation` defaults to `true` when omitted.
- Fixed low-risk commands may explicitly set `requiresConfirmation: false`.
- Wildcard and raw-shell commands are unsupported.
- Default command timeout is 10 minutes unless `timeoutMs` overrides it.
- Command concurrency is global single-flight: only one command runs at a time.

Do not force existing skills into TypeScript `execute()` yet. Existing scripts should keep running as fixed argv processes. Add native TypeScript skill modules later only if there is real value.

## 4. Implementation Phases

### Phase 0: Repo Restructure

- Completed:
  - `bemo/` -> `skills/bemo/`
  - `gmail/` -> `skills/gmail/`
  - `linux-janitor/` -> `skills/linux-janitor/`
  - `backlog/` -> `skills/backlog/`
- Completed path updates:
  - `agent/commands.json`
  - Bemo cron setup
  - `skills.md`
- Keep `agent/` at root level.

### Phase 1: Persistence, Logging, And Runtime State

- Add SQLite database at `agent/data/agent.sqlite`.
- Ignore old file state such as `agent/logs/telegram-state.json` after SQLite offset persistence exists.
- Store:
  - Telegram offset
  - chat history
  - trace events
  - command runs
  - pending confirmations
  - runtime state snapshots when useful
- Add tables before building debug commands:

```sql
chat_messages(chat_id, user_id, role, content, trace_id, created_at)
trace_events(trace_id, event, payload_json, created_at)
command_runs(trace_id, chat_id, command_name, label, cwd, command, status, started_at, finished_at, exit_code, output_tail, error_message)
pending_confirmations(chat_id, trace_id, command_name, payload_json, expires_at, created_at)
runtime_state(key, value_json, updated_at)
```

- Add `agent/src/logging/logger.ts`.
- Add `generateTraceId()`.
- Ensure all logs include `{ traceId }`.
- Prefer a wrapper API instead of raw `logger.info()` everywhere:

```ts
log.info(traceId, "message.received", { adapter: "telegram" });
log.error(traceId, "command.failed", { error });
```

- Avoid the old plan's unfiltered multi-transport logger problem. If logs are split into `ai`, `skills`, `app`, use a `channel` field and transport filters.
- Define a small event taxonomy before writing more orchestration logic:

```text
message.received
message.rejected
route.started
route.completed
command.started
command.output
command.completed
command.failed
telegram.reply.started
telegram.reply.completed
telegram.reply.failed
system.status.requested
debug.trace.requested
```

- Persist enough structured data to answer:
  - What is currently running?
  - What was the last command?
  - What was the last error?
  - What happened for a given `traceId`?

Minimum runtime state:

```ts
type RuntimeState = {
  currentRun?: {
    traceId: string;
    chatId: string;
    label: string;
    skillSlug?: string;
    command: string;
    startedAt: string;
  };
  lastRun?: {
    traceId: string;
    label: string;
    status: "success" | "failed";
    finishedAt: string;
    outputTail: string;
  };
  lastError?: {
    traceId: string;
    message: string;
    stack?: string;
    at: string;
  };
};
```

### Phase 2: Message Adapter And Router

- Define `StandardMessage`:

```ts
type StandardMessage = {
  traceId: string;
  provider: "telegram";
  chatId: string;
  userId: string;
  text: string;
  timestamp: Date;
};
```

- Move Telegram polling logic out of `bot.ts` into `adapters/telegram`.
- Keep Telegram API calls in `telegram/client.ts`.
- `core/router.ts` decides:
  - fixed command -> command router
  - normal text -> AI router later
  - unsupported input -> help/fallback
- If a Telegram message comes from any chat other than `TELEGRAM_CHAT_ID`, reply `không có quyền`.
- No `/whoami` command is needed for now.

### Phase 3: Command Router

- Keep command aliases as zero-AI fast path.
- `agent/commands.json` is the only command catalog.
- Skill folders do not need to define runnable commands in `SKILL.md`.
- `commands.json` should point to `../skills/<slug>`.

Example:

```json
{
  "allow": [
    {
      "name": "bemo.checkout",
      "label": "Bemo checkout",
      "skillSlug": "bemo",
      "aliases": ["/bemo-checkout", "bemo checkout"],
      "cwd": "../skills/bemo",
      "argv": ["npm", "run", "checkout"],
      "requiresConfirmation": true,
      "externalSideEffect": true
    }
  ]
}
```

- Commands use fixed argv arrays and execute without a shell.
- Wildcard and model-provided raw shell are disabled.
- Catalog loading rejects duplicate aliases, missing skills, and stale cwd paths.
- The executor passes only a minimal non-secret environment set.
- AI normally emits only `commandName`.
- Add `requiresConfirmation` for commands that write to external services or destroy data. Direct fixed commands may run without confirmation only when config says so.
- Confirmation flow:
  - Store pending confirmation in SQLite with `chatId`, `traceId`, `commandName`, exact preview, action digest, payload, and expiry.
  - Confirmation expires after 2 minutes.
  - User confirms with `confirm <commandName> <approvalToken>`.
  - Example: `confirm bemo.run a1b2c3d4e5f6`.
  - Recompute the digest before execution and reject changed actions/previews.
  - If the user sends another command while a confirmation is pending, cancel the old pending confirmation.
  - Expired confirmations are rejected and must be requested again.
- Add concurrency guard so only one command runs at a time per chat or globally.
- Because Telegram scope is currently single-user, implement this as one global command lock.
- Log command start/end/output tail with `traceId`.
- Return concise Telegram response.
- Add built-in non-AI debug commands:

```text
/status      - current run, uptime, loaded commands count
/last        - last command result and output tail
/last-error  - last error with traceId
/debug <id>  - lifecycle events for a traceId
/commands    - explicit command aliases grouped by skill
/skills      - scanned skills and descriptions
```

- These commands must work before AI routing is implemented.
- `/debug <traceId>` should read structured logs or an event store, not free-form grep output.
- `/debug <traceId>` returns raw event JSON.
- `/last-error` returns the latest failed command, regardless of command name.
- `/status` should include uptime, current command, pending confirmation/queue state, loaded command count, and SQLite DB path.

### Phase 4: Skill Registry

- Implement `SkillRegistry`:
  - scan `../skills/*/SKILL.md`
  - parse frontmatter
  - expose `listSkills()`, `getSkill(slug)`, `loadSkillContent(slug)`
- Use `skills.md` as the contract for expected `SKILL.md` shape.
- Skill slug is always the folder name.
- Reject skills missing `description` in frontmatter.
- Skill changes require bot restart for now; no hot reload is needed.
- Do not inject all skill content into prompts.
- First routing pass can be simple keyword matching against `slug`, `name`, `description`.
- `/skills` should use this registry, so the user can verify what the agent currently understands.

### Phase 5: Context Hydrator

Add a rule-based `ContextHydrator` between `Router` and `AI Provider`.

```text
Telegram message
-> StandardMessage
-> Router
-> Context Hydrator
-> AI Provider
-> Command Executor / Reply
```

The hydrator decides what context is safe and useful to send to AI. It should be deterministic first; do not use AI to decide context yet.

Hydrated context shape:

```ts
type HydratedContext = {
  message: StandardMessage;
  recentChat: ChatMessage[];
  skillMetadata: SkillMetadata[];
  selectedSkillContent?: string;
  allowedCommands: AllowedCommand[];
  relevantRuns?: CommandRun[];
  relevantTraceEvents?: TraceEvent[];
};
```

Rule set:

- Normal question:
  - include recent chat
  - include skill metadata
  - include allowed commands summary
- Command/run intent:
  - include recent chat
  - include skill metadata
  - include allowed commands
  - include full `SKILL.md` only when a likely skill is detected
- Skill explanation:
  - include skill metadata
  - include full `SKILL.md` for the mentioned skill
- Debug/history question:
  - trigger on words like `lỗi`, `bug`, `vừa rồi`, `lúc nãy`, `tại sao`, `failed`, `error`
  - include recent chat
  - include latest relevant `command_runs`
  - include latest failed run when no exact trace is referenced
  - include `trace_events` for the selected traceId
  - include sanitized output tail/error message

The AI should not query SQLite directly. It only receives the hydrated context selected by this module.

Context budget:

- recent chat: max 20 messages
- selected full `SKILL.md`: max 8 KB
- relevant command runs: max 3
- trace events: max 50 events
- output tail: max 4 KB
- total dynamic context: max 24 KB before provider-specific tokenization

If a context section exceeds its budget, truncate from the older/less relevant side and include a clear marker such as `[truncated: showing latest 50 trace events]`.

The hydrator should keep cacheable and dynamic context separate:

```text
Cacheable prefix:
- system prompt
- safety rules
- response format contract
- summarized `skills.md` contract, not the full file
- stable skill metadata
- stable command/tool schemas

Dynamic context:
- current user message
- recent chat
- selected full SKILL.md content
- command_runs
- trace_events
- last error/output tail
```

Do not put timestamps, traceIds, recent chat, command output, or other per-request data in the cacheable prefix.

### Phase 6: AI Router

- Add provider interface:

```ts
interface AiProvider {
  complete(input: AiRequest): Promise<AiResponse>;
}
```

- Implement both OpenAI and Gemini providers from the start behind the same interface.
- Use official provider SDKs for OpenAI and Gemini.
- Provider config shape:

```ts
type AiProviderConfig = {
  default: "openai" | "gemini";
  providers: {
    openai?: {
      apiKeyEnv: string;
      model: string;
    };
    gemini?: {
      apiKeyEnv: string;
      model: string;
    };
  };
};
```

- Route all calls through the configured `default` provider unless a future command/config explicitly overrides it.
- Store provider/model config in `agent/config.json`; read API keys from `.env` via the configured env var names.
- Load the stable system prompt from `agent/prompts/system.md`.
- Design prompts for provider prompt caching:
  - Put stable instructions first.
  - Keep cacheable prefix byte-stable across requests.
  - Sort skill metadata and command schemas deterministically.
  - Do not inject dynamic memory before the cacheable prefix.
  - Append dynamic hydrated context after the stable prefix.
- Prompt flow:
  1. Send user message + available skill metadata.
  2. Ask model to choose an allowed command, ask a clarification, or answer normally.
  3. If a skill is selected, optionally load that skill's full `SKILL.md`.
  4. Execute only commands allowed by `agent/commands.json`.
  5. If `requiresConfirmation` is true, ask the user to confirm before execution.

- Do not let the model emit raw shell. It may select only a reviewed `commandName`.
- Loop prevention:
  - Max 1 command execution per incoming user message.
  - No autonomous fix-and-rerun loop after command failure.
  - After command failure, summarize the failure and wait for the user.
  - Presenter cannot trigger commands.
  - AI provider retry max 1 for transient provider/API failures.
  - Command retry requires explicit user action unless a future command config defines a reviewed retry policy.
- AI trace logging is mandatory:

```text
ai.request.created
ai.skill_candidates.selected
ai.tool_schema.created
ai.response.received
ai.tool.selected
ai.clarification.requested
ai.failed
```

- For every AI call, log:
  - provider/model
  - cacheable prefix version/hash
  - prompt cache hit/miss metrics when provider returns them
  - selected skill candidates
  - selected command/tool, if any
  - latency
  - token usage when provider returns it
  - sanitized request/response summary
- Never log full secrets, cookies, env values, or Telegram token.

### Phase 7: Memory And Retention

- Persist to SQLite.
- Store:
  - chat id
  - full Telegram chat content from both user and assistant
  - traceId
  - selected skill/command
  - timestamp
- Also store enough execution state for `/debug <traceId>` and `/last-error`.
- AI should use chat history through `ContextHydrator`, not by reading `chat_messages` directly.
- Debug/history answers should use operational memory (`command_runs`, `trace_events`) through `ContextHydrator`.
- Suggested retention:
  - chat messages: max 1000 messages per chat, no day-based limit for now
  - trace events: 14 days
  - command runs: 30 days
  - pending confirmations: expire within minutes
  - output storage: keep `output_tail` at 4 KB, not unlimited stdout/stderr
  - SQLite does not need encryption as long as secrets are not stored

### Phase 8: Presenter

- For complex script output, summarize before replying.
- Presenter runs for every successful command response.
- For short/simple output, Presenter can return a near-direct concise response.
- For long or structured output, Presenter should summarize before replying.
- Preserve raw output tail in logs.
- If Presenter AI summarization fails, fall back to returning the raw `output_tail`.

### Phase 9: Cron Integration

- Keep Bemo checkout cron as raw Ubuntu cron for now.
- Cron stays independently runnable from `skills/bemo/scripts/run-cron-telegram.js`.
- Agent `/last`, `/last-error`, and `/debug` only need to cover commands launched through the agent in the first implementation.
- Optional future integration:
  - Read `skills/bemo/logs/cron.log` and `skills/bemo/logs/cron-run.log` when the user asks about cron history.
  - Or add an agent CLI to record cron runs into SQLite later.
- Do not build an app scheduler in this phase.

## 5. Safety Rules

- Command aliases must be explicit and reviewed.
- AI cannot run arbitrary shell; it may select only fixed argv entries in the command catalog.
- Skill commands that affect external services should say so in `SKILL.md`.
- Secrets stay in `.env`, never in `SKILL.md`.
- Destructive commands need either a fixed safe command or `requiresConfirmation`.
- Logs should avoid dumping secrets, cookies, tokens, or full env.
- Do not encrypt SQLite for now; prevent secret storage instead.
- Telegram scope is single-user for now: only `TELEGRAM_CHAT_ID` is allowed. No role system is needed until there are multiple users.
- User-facing error replies should be concise, but logs should retain the actionable technical details.

## 6. End-To-End Validation

After each implementation milestone, run a minimal validation suite to prove the agent still works end to end. This phase is not a separate feature; it is the acceptance gate for the system.

Automated checks:

```bash
cd agent
npm test
```

Minimum automated coverage:

- TypeScript compiles.
- `agent/commands.json` loads from the `allow` format.
- Command names and aliases resolve correctly.
- Configured command `cwd` values point to existing skill folders.
- `requiresConfirmation` flags are read correctly.
- Command execution captures success output.
- Command execution captures non-zero exit code and stderr output.
- SQLite schema initializes successfully.
- Command runs persist to SQLite.
- Trace events persist to SQLite.
- Pending confirmation expires after 2 minutes.
- Sending a new command cancels old pending confirmation.
- Shell metacharacters remain literal argv values and cannot trigger shell evaluation.
- Context Hydrator respects context budgets and truncation markers.
- Skill Registry rejects skills missing `description`.

Manual smoke checks through Telegram:

- `/help` returns available commands.
- `/commands` returns aliases grouped by skill.
- `/skills` returns scanned skill metadata.
- `/status` shows uptime, current command, pending confirmation/queue state, loaded command count, and SQLite DB path.
- `/last` returns the latest command run.
- `/last-error` returns the latest failed command.
- `/debug <traceId>` returns raw event JSON.
- Unauthorized chat receives `không có quyền`.
- A command with `requiresConfirmation: false` can run directly.
- A command with `requiresConfirmation: true` asks for `confirm <commandName> <approvalToken>`.
- Presenter returns a concise success message; if AI Presenter fails, raw `output_tail` is returned.

AI smoke checks after provider integration:

- Normal question uses recent chat + skill metadata only.
- Skill explanation loads the relevant `SKILL.md`.
- Debug/history question includes relevant command run and trace events.
- AI can choose an allowed command by `commandName`.
- AI cannot run raw shell.
- Prompt cacheable prefix hash is logged.

## 7. Immediate Next Steps

1. Add SQLite schema for trace events, command runs, chat history, pending confirmations, and runtime state.
2. Add structured logger, event taxonomy, and runtime state.
3. Wire runtime persistence for command runs, trace events, chat messages, Telegram offset, and confirmation flow.
4. Add `/status`, `/last`, `/last-error`, `/debug`, `/commands`.
5. Refactor `agent/src/bot.ts` into adapter/router modules.
6. Add `SkillRegistry` and make `/help` include commands grouped by skill.
7. Add rule-based `ContextHydrator`.
8. Keep wildcard and raw-shell command execution disabled.
9. Add config loading from `agent/config.json` and system prompt loading from `agent/prompts/system.md`.
10. Only then add AI provider integration.
