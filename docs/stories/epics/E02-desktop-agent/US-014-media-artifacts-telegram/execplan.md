# Exec Plan

## Goal

Provide reusable secure media delivery for desktop and future skills.

## Risk Classification

Risk flags: authorization, audit/security, external system, data retention.

## Work Phases

1. Implement artifact store and expiry cleanup.
2. Add Telegram media transport.
3. Prove ownership and delivery behavior with fakes and one harmless smoke.

## Stop Conditions

Pause if artifact retention, chat ownership, or file-size limits are unclear.
