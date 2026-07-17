# US-023 Browser Safety and Network Policy

## Status

planned

> Migration notice (2026-07-17, ADR 0017 P2.5): The URL policy is now framed as
> **guardrails**, not an inherited sandbox boundary. Private/localhost navigation
> is governed by owner posture (`permissions.browser.privateNavigation`, default
> `allow`) rather than blanket-blocked; only protocol escapes and SSRF/non-routable
> destinations remain hard-denied regardless of config. The historical acceptance
> criteria below are preserved as the original design; the reconciled criteria
> follow.

## Lane

high-risk

## Product Contract

The agent's browser capability treats network restrictions as guardrails under the trusted-local model (ADR 0017): ordinary navigation — including the owner's own private network — is allowed by default, while protocol escapes and evident SSRF targets are hard-denied, and consequential/destructive UI actions require human confirmation.

## Relevant Product Docs

- `docs/stories/epics/E03-browser-capability/README.md`
- `docs/decisions/0017-trusted-local-default-allow-cutover.md`

## Acceptance Criteria (reconciled — ADR 0017 P2.5)

- **URL guardrail (non-configurable):** The system hard-denies navigation to protocol-escape schemas (`file://`, `javascript:`, `data:`, `chrome://`, `devtools://`) and to SSRF/non-routable destinations: cloud metadata and IPv4 link-local (`169.254.0.0/16`, including `169.254.169.254`), the unspecified baseline (`0.0.0.0/8`), multicast (`224.0.0.0/4`), and reserved (`240.0.0.0/4`). These are denied at both `PermissionPolicy` and the browser-service request gate, regardless of owner posture. DNS resolution is performed for public-shaped hostnames so a domain that resolves to a metadata IP (e.g. `metadata.google.internal`) is still caught.
- **Navigation posture (owner-configurable):** Navigation to private/loopback/localhost/intranet hosts is governed by `permissions.browser.privateNavigation` (default `"allow"`); `"confirm"` raises `CONFIRMATION_REQUIRED`, `"deny"` denies. Public hosts use `publicNavigation` (default `"allow"`). A host declared in `permissions.browser.allowedHosts` (exact `host[:port]` match) is an explicit owner trust declaration and is allowed, bypassing the posture. `PermissionPolicy` under `agent/src/security/permissionPolicy.ts` is the sole authority for the posture; `agent/src/browser/url-policy.ts` is the pure guardrail.
- **Action Policy:** Evaluates the action and the target element. Any click, fill, or type action on interactive elements whose role is `button`, `menuitem`, `checkbox` or similar, and whose accessible name matches terms like `Delete`, `Remove`, `Pay`, `Purchase`, `Submit`, `Send`, `Publish`, or `Confirm` is flagged as a consequential action.
- **Integration:** `PermissionPolicy` evaluates all `browser` actions. If flagged as consequential, or navigating to a host whose posture is `"confirm"`, it returns `outcome: "confirm"` and `reasonCode: "CONFIRMATION_REQUIRED"`.
- Resumes execution safely using the digest-bound inline button confirmation flow when approved by the user.

## Acceptance Criteria (historical — pre-ADR-0017, superseded)

- **URL Policy:** The system blocks navigation to `localhost`, `127.0.0.1`, `0.0.0.0`, `169.254.169.254`, private LAN IP ranges (e.g. `10.0.0.0/8`, `192.168.0.0/16`), and `file://`, `chrome://`, or `devtools://` schemas. Allows private hosts only if declared in an allowlist (`allowedHosts`) inside `agent/config.json`.

## Design Notes

- **New files:**
  - `agent/src/browser/url-policy.ts` (Network IP range and schema validations)
  - `agent/src/browser/action-policy.ts` (Dangerous element name and role heuristics)
- **Modified files:**
  - `agent/src/security/permissionPolicy.ts` (Incorporate browser action evaluation and URL policies)

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | `test/url-policy.test.js` — `isSsrfGuardedIp` covers the metadata/non-routable set; private LAN and loopback are allowed by default; protocol escapes are denied; DNS catches `metadata.google.internal`. `test/action-policy.test.js` — dangerous-button keyword heuristics. |
| Integration | `test/browser-safety.test.js` — default-allow localhost/`192.168.x`, SSRF guardrail denies `169.254.169.254`, `privateNavigation:"deny"` tightens, and `confirm` for clicking a button labeled "Delete Account"/"Send Message". |
| E2E | Ask the agent to navigate to a page and click a "Delete" button, verifying that it displays a preview and a `confirm browser <digest>` prompt. |

## Harness Delta

- Add `allowedHosts` block to config under permissions.

## Evidence

None.
