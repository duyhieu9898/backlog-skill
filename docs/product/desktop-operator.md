# Desktop Operator Contract

## Goal

The single authorized Telegram user can request tightly scoped observation and
automation on the local desktop without giving the model raw shell access.

## Core Concepts

- **Desktop capability**: a platform adapter that declares available actions,
  required OS permissions, and supported displays.
- **Artifact**: a temporary screenshot or file with an ID, MIME type, byte
  size, digest, expiry, and local path that is never exposed to the model.
- **App registry**: reviewed app IDs mapped to fixed launch actions; raw
  executable paths are not accepted from chat or the model.
- **Workflow**: a bounded sequence of observation and approved actions linked
  by trace ID and stopped when the observed desktop state is unexpected.

## Safety Rules

- Screen capture, app launch, UI input, and media delivery pass central policy.
- Sensitive actions require exact-action confirmation.
- Raw screenshots are sent only to the authorized chat and expire locally.
- The model receives image content only when the user requests analysis.
- UI actions use stable targets and stop on ambiguity; they do not loop clicks.
