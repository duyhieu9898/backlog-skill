# 0012 Require Runtime Telegram Secrets

Date: 2026-07-06

## Status

Accepted

## Context

The Telegram configuration contained source-code fallback values for the bot
token and allowed chat ID. This allowed startup without explicit runtime
configuration and exposed credentials through repository history.

## Decision

- Require `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from the runtime
  environment loaded from the ignored `agent/.env` file.
- Fail startup with a clear error when either value is absent.
- Validate `TELEGRAM_POLL_TIMEOUT` as an integer from 0 through 50.
- Never provide secret or account-identifier fallback values in tracked code.

## Consequences

- Fresh installations must configure Telegram explicitly before startup.
- Missing configuration fails immediately instead of silently using another
  bot or account.
- The previously committed token must be rotated outside the repository; code
  removal cannot revoke a credential already present in Git history.

## Verification

```bash
cd agent && npm test
```

Tests cover required values, explicit configuration, and timeout validation.
