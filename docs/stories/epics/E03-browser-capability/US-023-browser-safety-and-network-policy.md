# US-023 Browser Safety and Network Policy

## Status

planned

## Lane

high-risk

## Product Contract

The agent's browser capability is restricted from accessing internal networks or performing destructive, consequential actions without human authorization. The system checks all navigation URLs and page targets, raising a confirmation prompt whenever a risk is identified.

## Relevant Product Docs

- `docs/stories/epics/E03-browser-capability/README.md`

## Acceptance Criteria

- **URL Policy:** The system blocks navigation to `localhost`, `127.0.0.1`, `0.0.0.0`, `169.254.169.254`, private LAN IP ranges (e.g. `10.0.0.0/8`, `192.168.0.0/16`), and `file://`, `chrome://`, or `devtools://` schemas. Allows private hosts only if declared in an allowlist (`allowedHosts`) inside `agent/config.json`.
- **Action Policy:** Evaluates the action and the target element. Any click, fill, or type action on interactive elements whose role is `button`, `menuitem`, `checkbox` or similar, and whose accessible name matches terms like `Delete`, `Remove`, `Pay`, `Purchase`, `Submit`, `Send`, `Publish`, or `Confirm` is flagged as a consequential action.
- **Integration:** The `PermissionPolicy` under `agent/src/security/permissionPolicy.ts` evaluates all `browser` actions. If flagged as consequential or navigating to external targets requiring approval, it returns `outcome: "confirm"` and `reasonCode: "CONFIRMATION_REQUIRED"`.
- Resumes execution safely using the digest-bound inline button confirmation flow when approved by the user.

## Design Notes

- **New files:**
  - `agent/src/browser/url-policy.ts` (Network IP range and schema validations)
  - `agent/src/browser/action-policy.ts` (Dangerous element name and role heuristics)
- **Modified files:**
  - `agent/src/security/permissionPolicy.ts` (Incorporate browser action evaluation and URL policies)

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Test regexes for private LAN networks and keywords matching dangerous buttons. |
| Integration | Verify `PermissionPolicy` returns `deny` for `localhost` and `confirm` for clicking a button labeled "Delete account". |
| E2E | Ask the agent to navigate to a page and click a "Delete" button, verifying that it displays a preview and a `confirm browser <digest>` prompt. |

## Harness Delta

- Add `allowedHosts` block to config under permissions.

## Evidence

None.
