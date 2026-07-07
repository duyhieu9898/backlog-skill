# US-009 Validation

## Automated Proof

```text
cd agent && npm run check
cd agent && npm test
cd skills/bemo && npm test
```

Current result:

- TypeScript check passes.
- Agent tests pass 42/42.
- Bemo tests pass 6/6.
- Installed service restart/build/polling passes.

## Covered Cases

- Provider response must have exactly one outcome.
- Unknown tool names are rejected and fed back as tool results.
- JSON-stdin command input is schema validated.
- Read-only/non-confirmed command can feed a later confirmed command preview.
- Confirmed effect does not run until token confirmation.
- Confirmation executes the exact stored tool call and does not auto-resume.

## Remaining Proof

- Human Telegram natural-language request routes through configured provider to
  Bemo prepare/create preview.
- No real Bemo write is confirmed during smoke.
