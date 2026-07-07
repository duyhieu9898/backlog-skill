# US-009 Exec Plan

1. Extend provider response types to support validated structured `toolCall`.
2. Expose file tools and allowlisted commands as AI tool definitions.
3. Add command JSON-stdin input and schema validation.
4. Add bounded `AgentToolLoop`.
5. Store exact pending AI tool confirmations in SQLite.
6. Route natural-language messages through the generic loop.
7. Update prompts, tests, Bemo command schemas, and Harness docs.
8. Run TypeScript, agent, and Bemo tests.
9. Restart service and complete Telegram smoke before marking implemented.
