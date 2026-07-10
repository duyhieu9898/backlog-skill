# Design

## Application Flow

A workflow records intent, current observation, planned action, confirmation,
result, and next observation. It can resume only from a matching state digest.
Workflow metadata is added through the existing SQLite schema/repository
migration path and references US-014 artifact IDs; it does not duplicate
artifact bytes, pending confirmations, or raw AI interaction logs.

## Observability

Link workflow ID, trace IDs, artifact IDs, tool outputs, and user-visible stop
reason through the common desktop event envelope. Prompt trials use the compact
AI-log index first, then the relevant raw record only.
