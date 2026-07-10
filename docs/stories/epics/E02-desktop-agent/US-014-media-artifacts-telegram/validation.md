# Validation

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | MIME, size, digest, expiry, and ownership validation. |
| Integration | Fake Telegram multipart upload and cleanup after delivery. |
| E2E | Authorized chat receives a harmless generated image. |
| Security | Wrong chat, expired ID, path traversal, and oversized file are denied. |

## Acceptance Evidence

TBD
