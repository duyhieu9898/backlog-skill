# 0009 Safe File Tool Semantics

Date: 2026-07-03

## Status

Accepted

## Context

US-002 established a deterministic permission boundary and typed action
foundation. US-003 needs concrete filesystem capabilities without granting the
AI router unrestricted file access or allowing content to leak through traces.

## Decision

Provide one internal `FileTools` executor for `file.read`, `file.list`,
`file.exists`, `file.mkdir`, `file.write`, and `file.patch`.

- Every action is evaluated by `PermissionPolicy` immediately before I/O.
- Read results are capped and carry an explicit truncation marker.
- Directory listings omit entries denied by policy.
- Mutations require confirmation and return structured previews before any
  write occurs.
- Writes are UTF-8 text only, capped at 1 MiB, and use an atomic temporary-file
  rename while preserving an existing file's mode.
- Patches use exact text replacement and require the search text to match
  exactly once.
- Delete remains excluded.
- Trace events record action kind, canonical path, result code, and byte counts,
  but never file content.
- The API remains internal until US-009 adds validated AI tool routing. Direct
  confirmation binding remains part of US-005.

## Alternatives Considered

1. Expose raw filesystem calls to the model. Rejected because it bypasses typed
   validation and the central permission boundary.
2. Add public Telegram file commands immediately. Rejected because US-003 says
   internal API first and AI/tool routing belongs to US-009.
3. Support binary content and delete in v1. Rejected because neither has a
   current product requirement that justifies the additional data-loss risk.
4. Apply multi-match patches. Rejected because an ambiguous patch can modify
   more content than the preview implies.

## Consequences

Positive:

- Future Router integration receives structured results and mutation previews.
- File writes are bounded, reversible before confirmation, and auditable
  without persisting content.
- Policy-denied children do not leak through directory listings.

Tradeoffs:

- Text files larger than 1 MiB cannot be mutated through this first version.
- Exact-match patching is intentionally less flexible than a general diff
  engine.
- E2E Telegram proof remains unavailable until validated tool routing exists.

## Verification

```bash
cd agent && npm test
```

The suite covers reads, truncation, listings, existence checks, mkdir, atomic
writes, exact patches, previews, confirmation, denied secrets, symlink escape,
binary refusal, and content-free trace events.
