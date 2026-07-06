# 0010 Fixed Argv Command Execution

Date: 2026-07-06

## Status

Accepted

## Context

The local operator stored allowlisted commands as shell strings and executed
them through Bash. A trusted wildcard entry also allowed the AI response to
provide a raw command. Path policy limited cwd, but shell parsing, inherited
secret-bearing environment variables, and stale skill entries remained outside
the enforced boundary.

## Decision

- Store each command as a fixed non-empty `argv` array.
- Execute with Node `spawn` and `shell: false`.
- Remove wildcard commands and `rawCommand` from the AI response contract.
- Pass only reviewed non-secret environment keys needed by local CLI tools.
- Validate command names, labels, argv values, aliases, cwd, and skill ownership
  whenever the catalog loads.
- Show executable, arguments, cwd, and timeout before confirmation.
- Mark external mutations explicitly so policy forces confirmation.

## Alternatives Considered

1. Keep shell strings with a denylist. Rejected because shell grammar is too
   broad for a denylist to be a reliable authority boundary.
2. Parse shell strings into argv. Rejected because quoting and expansion rules
   would preserve unnecessary ambiguity and compatibility risk.
3. Keep raw shell only for trusted skills. Rejected because model-generated
   shell materially expands authority beyond reviewed catalog entries.

## Consequences

Positive:

- Shell metacharacters are passed literally and cannot create a second command.
- Child processes no longer inherit API tokens by default.
- Removed or renamed skills break loudly at catalog load instead of at runtime.
- Confirmation text reflects the actual executable contract.

Tradeoffs:

- Pipelines and shell built-ins require a reviewed wrapper script or dedicated
  executable.
- Commands needing additional environment values must add an explicit reviewed
  mechanism rather than inheriting the entire agent environment.
- Exact-action confirmation binding is implemented by ADR-0011 under US-005.

## Verification

```bash
cd agent && npm test
```

The suite covers fixed argv execution, literal shell metacharacters, timeout,
minimal environment, stale catalog entries, previews, and policy enforcement.
