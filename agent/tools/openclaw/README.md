# OpenClaw Tool Reference

This directory is a read-only upstream reference for selected OpenClaw agent
tools and their tests. It is not part of the `my-agent` runtime, build, or
dependency graph.

Source: https://github.com/openclaw/openclaw

Pinned upstream commit: `e9e7d385e013ef9dd0daba614a263d334f02eac0`
(retrieved 2026-07-13).

Included tool families:

- `computer-tool` — desktop observation and frame-bound input.
- `cron-tool` — scheduled job lifecycle and schema canonicalization.
- `web-fetch` and `web-search` — guarded web retrieval.
- `image-tool` — media understanding.

Each source file has its corresponding upstream test file beside it. The
upstream code is MIT licensed; retain `LICENSE` and this provenance when
adapting any substantial part into this repository.
