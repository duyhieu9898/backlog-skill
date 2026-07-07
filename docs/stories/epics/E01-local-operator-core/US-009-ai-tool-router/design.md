# US-009 Design

## Contract

The model returns exactly one of:

- `text`
- `clarification`
- `toolCall`

`toolCall` must name a registered tool and provide arguments that match that
tool's schema. The executor, not the model, enforces permissions and
confirmation.

## Tool Sources

- File tools: `file.read`, `file.list`, `file.exists`, `file.mkdir`,
  `file.write`, `file.patch`.
- Command tools: every entry in `agent/commands.json` is exposed as
  `command.<name>`.

Command tools may declare:

- `inputMode: "json-stdin"`
- `inputSchema`

When present, arguments are validated and piped as JSON stdin. They are not
converted into shell text or dynamic argv.

## Loop

```text
user message
  -> hydrate selected skill context
  -> provider chooses one structured outcome
  -> executor validates selected tool and args
  -> execute non-confirmed tool or return confirmation preview
  -> append result for provider if safe to continue
  -> stop after four tool steps or first confirmation preview
```

After `confirm <tool> <token>`, the agent re-prepares the stored tool call,
checks the preview digest, executes exactly that approved action, and stops.

## Skill Boundary

Skill-specific logic belongs behind skill commands and schemas. For Bemo,
`workflows/late-timeoff.js prepare` owns skip parsing and plan construction, while
`workflows/late-timeoff.js create` owns plan validation and create execution. The core
router only knows it is running registered command tools.
