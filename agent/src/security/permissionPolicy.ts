import fs from "node:fs";
import path from "node:path";

import { isDesktopToolAction, isBrowserToolAction } from "../tools/contracts";
import type {
  DesktopToolAction,
  BrowserToolAction,
  CommandRunAction,
  NormalizedToolAction,
  PolicyDecision,
  ToolAction,
} from "../tools/contracts";
import type { DesktopStatus } from "../tools/computer/contracts";

import { evaluateUrlSync, isPrivateIp, isPrivateHostname } from "../browser/url-policy";
import { evaluateAction } from "../browser/action-policy";
import type { BrowserActionPolicyContext } from "../browser/action-policy";
import type { BrowserPermissionConfig } from "../config/app";
import { isSecretLike, isClearlyDestructiveCommand, needsSystemApproval } from "./policy-patterns";

export type PermissionPolicyConfig = {
  desktopAppIds?: string[];
  browser?: BrowserPermissionConfig;
};

export type PermissionContext = {
  confirmationGranted?: boolean;
  /** Original owner request for the current run; never model-generated tool text. */
  userIntent?: string;
  desktopStatus?: DesktopStatus;
  browserContext?: BrowserActionPolicyContext;
};

function nearestExistingPath(candidate: string): { existing: string; suffix: string[] } {
  let current = candidate;
  const suffix: string[] = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing parent for ${candidate}`);
    suffix.unshift(path.basename(current));
    current = parent;
  }

  return { existing: current, suffix };
}

export function canonicalizePolicyPath(candidate: string): string {
  if (!candidate || candidate.includes("\0")) throw new Error("Path is empty or contains NUL.");
  const absolute = path.resolve(candidate);
  const { existing, suffix } = nearestExistingPath(absolute);
  return path.join(fs.realpathSync(existing), ...suffix);
}

/**
 * A clear owner request is approval for the exact task, including the ordinary
 * package/service steps needed to complete it. This is deliberately narrow:
 * it only relaxes the system-impact prompt, never the destructive deny rules.
 */
function hasExplicitSystemIntent(action: CommandRunAction, userIntent?: string): boolean {
  if (!userIntent || !needsSystemApproval(action)) return false;
  const intent = userIntent.toLowerCase();
  const asksForSystemWork = /\b(?:install|uninstall|remove|configure|config|restart|start|stop|enable|disable|upgrade|update)\b|cài(?:\s+đặt)?|gỡ|cấu\s*hình|khởi\s*động|dừng|bật|tắt/.test(intent);
  if (!asksForSystemWork) return false;

  // A generic request such as “restart the service” is intentionally enough
  // for the matching service operation. When a concrete package/service name
  // appears, require that it also appears in the command.
  const command = [action.executable || "", ...(action.args || []), action.shellCommand || ""].join(" ").toLowerCase();
  const namedTargets = intent.match(/\b[a-z0-9][a-z0-9._+-]{2,}\b/g) || [];
  const ignored = new Set(["install", "uninstall", "remove", "configure", "config", "restart", "start", "stop", "enable", "disable", "upgrade", "update", "system", "service", "sudo", "please", "with", "this", "that"]);
  const requestedTargets = namedTargets.filter((term) => !ignored.has(term));
  return requestedTargets.length === 0 || requestedTargets.some((term) => command.includes(term));
}

/** Extracts a normalized hostname (IPv6 brackets and trailing dot stripped) for posture classification. */
function hostOf(url: string): string {
  try {
    let hostname = new URL(url).hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.substring(1, hostname.length - 1);
    }
    if (hostname.endsWith(".")) hostname = hostname.substring(0, hostname.length - 1);
    return hostname;
  } catch {
    return "";
  }
}

/** Extracts the lowercase `host` (hostname[:port]) used for allowedHosts exact-match. */
function hostKeyOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeAction(action: ToolAction): NormalizedToolAction {
  if (action.kind === "command.run") {
    return { ...action, cwd: canonicalizePolicyPath(action.cwd) };
  }
  if (isDesktopToolAction(action) || isBrowserToolAction(action)) return action;
  return { ...action, path: canonicalizePolicyPath((action as any).path) };
}

function desktopCapability(action: DesktopToolAction): DesktopStatus["capabilities"][number]["capability"] {
  switch (action.kind) {
    case "desktop.capture":
      return "screen.capture";
    case "desktop.launch":
      return "app.launch";
    case "desktop.observe":
      return "ui.observe";
    case "desktop.act":
      return "ui.act";
  }
}

function denied(
  action: NormalizedToolAction,
  reasonCode: Extract<PolicyDecision, { outcome: "deny" }>["reasonCode"],
  reason: string,
): PolicyDecision {
  return { outcome: "deny", reasonCode, reason, action };
}

export class PermissionPolicy {
  private readonly desktopAppIds: Set<string>;
  private readonly browserConfig: BrowserPermissionConfig;

  constructor(config: PermissionPolicyConfig) {
    this.desktopAppIds = new Set(config.desktopAppIds || []);
    this.browserConfig = config.browser || {};
  }

  evaluate(action: ToolAction, context: PermissionContext = {}): PolicyDecision {
    let normalized: NormalizedToolAction;
    try {
      normalized = normalizeAction(action);
    } catch (error) {
      return {
        outcome: "deny",
        reasonCode: "INVALID_PATH",
        reason: error instanceof Error ? error.message : String(error),
        action,
      } as PolicyDecision;
    }

    if (isDesktopToolAction(normalized)) {
      return this.evaluateDesktop(normalized, context);
    }

    if (isBrowserToolAction(normalized)) {
      return this.evaluateBrowser(normalized, context);
    }

    const target = normalized.kind === "command.run" ? normalized.cwd : normalized.path;
    if (normalized.kind === "command.run" && isClearlyDestructiveCommand(normalized)) {
      return denied(normalized, "DENIED_PATH", "Command matches a clearly destructive pattern.");
    }
    if (isSecretLike(target)) {
      if (!context.confirmationGranted) return { outcome: "confirm", reasonCode: "CONFIRMATION_REQUIRED", reason: `Sensitive path requires approval: ${target}`, action: normalized };
      return { outcome: "allow", reasonCode: "ALLOWED", reason: "Sensitive path approved for this task.", action: normalized };
    }

    if (
      normalized.kind === "file.read" ||
      normalized.kind === "file.list" ||
      normalized.kind === "file.exists"
    ) {
      return { outcome: "allow", reasonCode: "ALLOWED", reason: "Read path is allowed.", action: normalized };
    }

    const explicitSystemIntent = normalized.kind === "command.run" && hasExplicitSystemIntent(normalized, context.userIntent);
    const needsConfirmation =
      normalized.kind === "command.run"
        ? (normalized.requiresConfirmation || normalized.externalSideEffect || needsSystemApproval(normalized)) && !explicitSystemIntent
        : false;
    if (needsConfirmation && !context.confirmationGranted) {
      return {
        outcome: "confirm",
        reasonCode: "CONFIRMATION_REQUIRED",
        reason: `${normalized.kind} requires explicit confirmation.`,
        action: normalized,
      };
    }

    return {
      outcome: "allow",
      reasonCode: "ALLOWED",
      reason: `${normalized.kind} is allowed by policy.`,
      action: normalized,
    };
  }

  private evaluateDesktop(action: DesktopToolAction, context: PermissionContext): PolicyDecision {
    const capability = desktopCapability(action);
    const status = context.desktopStatus?.capabilities.find((entry) => entry.capability === capability);
    if (!status?.available || status.permission.state === "unavailable") {
      return denied(action, "DESKTOP_CAPABILITY_UNAVAILABLE", `${capability} is not available on this runtime.`);
    }
    if (status.permission.state !== "granted") {
      return denied(action, "DESKTOP_PERMISSION_DENIED", `${capability} permission is not granted.`);
    }
    if (action.kind === "desktop.launch" && !this.desktopAppIds.has(action.appId)) {
      return denied(action, "UNDECLARED_DESKTOP_APP", `Desktop app is not declared: ${action.appId}`);
    }
    if (
      (action.kind === "desktop.capture" || action.kind === "desktop.observe") &&
      action.displayId &&
      !context.desktopStatus?.displays.some((display) => display.id === action.displayId)
    ) {
      return denied(action, "UNKNOWN_DISPLAY", `Desktop display is not available: ${action.displayId}`);
    }
    return {
      outcome: "allow",
      reasonCode: "ALLOWED",
      reason: `${action.kind} is allowed as ordinary local desktop automation.`,
      action,
    };
  }

  private evaluateBrowser(action: BrowserToolAction, context: PermissionContext): PolicyDecision {
    const kind = action.kind;

    if (kind === "browser.open" || kind === "browser.navigate") {
      const url = (action as any).url;
      if (url) {
        // 1. Non-configurable guardrail: protocol escapes and SSRF/non-routable
        //    destinations (cloud metadata, link-local, unspecified, multicast).
        const allowedHosts = this.browserConfig.allowedHosts || [];
        const guardrail = evaluateUrlSync({ url, allowedHosts });
        if (guardrail.decision === "deny") {
          return {
            outcome: "deny",
            reasonCode: guardrail.code as any,
            reason: guardrail.reason,
            action,
          };
        }
        // An explicit allowedHosts entry is an owner trust declaration: it
        // bypasses the navigation posture below (legacy "exact match = allow").
        const hostKey = hostKeyOf(url);
        if (hostKey && allowedHosts.map((h) => h.toLowerCase()).includes(hostKey)) {
          return {
            outcome: "allow",
            reasonCode: "ALLOWED",
            reason: "Host is explicitly trusted by the owner (allowedHosts).",
            action,
          };
        }
        // 2. Configurable navigation posture (trusted-local: private default
        //    allow). `privateNavigation`/`publicNavigation` are owner policy and
        //    default to "allow"; an owner may set "confirm" or "deny" to tighten.
        const hostname = hostOf(url);
        const isPrivate = isPrivateHostname(hostname) || isPrivateIp(hostname);
        const mode = isPrivate
          ? this.browserConfig.privateNavigation ?? "allow"
          : this.browserConfig.publicNavigation ?? "allow";
        if (mode === "deny") {
          return {
            outcome: "deny",
            reasonCode: "NAVIGATION_MODE_DENIED" as any,
            reason: `Navigation to ${isPrivate ? "private/local" : "public"} host is denied by policy: ${hostname}`,
            action,
          };
        }
        if (mode === "confirm" && !context.confirmationGranted) {
          return {
            outcome: "confirm",
            reasonCode: "CONFIRMATION_REQUIRED",
            reason: `Navigation to ${isPrivate ? "private/local" : "public"} host requires confirmation: ${hostname}`,
            action,
          };
        }
      }
    }

    if (kind === "browser.act") {
      if (context.browserContext) {
        const decision = evaluateAction(context.browserContext, this.browserConfig);
        if (decision.decision === "deny") {
          return {
            outcome: "deny",
            reasonCode: "ACTION_DENIED" as any,
            reason: decision.reason,
            action,
          };
        }
        if (decision.decision === "confirm") {
          if (context.confirmationGranted) {
            return {
              outcome: "allow",
              reasonCode: "ALLOWED",
              reason: "Action confirmed by user.",
              action,
            };
          }
          return {
            outcome: "confirm",
            reasonCode: "CONFIRMATION_REQUIRED",
            reason: decision.reason,
            action,
            // Include fingerprint in the confirmation decision so ToolExecutor can extract it
            actionFingerprint: decision.actionFingerprint,
          } as any;
        }
      }
    }

    return {
      outcome: "allow",
      reasonCode: "ALLOWED",
      reason: `${action.kind} is allowed by policy.`,
      action,
    };
  }
}
