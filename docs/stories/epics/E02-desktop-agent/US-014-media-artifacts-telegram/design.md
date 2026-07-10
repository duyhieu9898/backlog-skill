# Design

## Domain Model

Artifacts have opaque IDs, MIME type, byte size, SHA-256, expiry, source trace,
owner chat, delivery state, and a private local path. Bytes stay in the local
artifact store; the existing SQLite repository/migration path stores only
metadata needed for ownership, expiry, cleanup, and trace joins. The presenter
returns text plus artifact references through one reusable response envelope.

## Application Flow

Artifact policy validates a file before the Telegram adapter uploads it with
multipart `sendPhoto` or `sendDocument`. Delivery consumes or expires the
artifact and cleanup removes the local file. Tool executors return artifact
references and never call Telegram directly.

## Observability

Use the common desktop trace envelope and existing raw provider-log index; raw
bytes are never copied into SQLite, trace events, or the model prompt.
