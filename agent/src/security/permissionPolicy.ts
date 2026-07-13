import fs from "node:fs";
import path from "node:path";

import { isDesktopToolAction } from "../tools/contracts";
import type {
  DesktopToolAction,
  NormalizedToolAction,
  PolicyDecision,
  ToolAction,
} from "../tools/contracts";
import type { DesktopStatus } from "../tools/computer/contracts";

export type PermissionPolicyConfig = {
  workspaceRoot: string;
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  deniedPaths: string[];
  desktopAppIds?: string[];
  desktopCaptureRequiresConfirmation?: boolean;
};

export type PermissionContext = {
  confirmationGranted?: boolean;
  desktopStatus?: DesktopStatus;
};

const DENIED_SEGMENTS = new Set([".git", "node_modules"]);
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^(?:credentials?|secrets?)(?:\..+)?$/i,
  /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

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

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isSecretLike(candidate: string): boolean {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(candidate)));
}

function hasDeniedSegment(candidate: string): boolean {
  return candidate.split(path.sep).some((segment) => DENIED_SEGMENTS.has(segment));
}

function normalizeRoots(roots: string[]): string[] {
  return roots.map(canonicalizePolicyPath);
}

function normalizeAction(action: ToolAction): NormalizedToolAction {
  if (action.kind === "command.run") {
    return { ...action, cwd: canonicalizePolicyPath(action.cwd) };
  }
  if (isDesktopToolAction(action)) return action;
  return { ...action, path: canonicalizePolicyPath(action.path) };
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
  private readonly workspaceRoot: string;
  private readonly allowedReadRoots: string[];
  private readonly allowedWriteRoots: string[];
  private readonly deniedPaths: string[];
  private readonly desktopAppIds: Set<string>;
  private readonly desktopCaptureRequiresConfirmation: boolean;

  constructor(config: PermissionPolicyConfig) {
    this.workspaceRoot = canonicalizePolicyPath(config.workspaceRoot);
    this.allowedReadRoots = normalizeRoots(config.allowedReadRoots);
    this.allowedWriteRoots = normalizeRoots(config.allowedWriteRoots);
    this.deniedPaths = normalizeRoots(config.deniedPaths);
    this.desktopAppIds = new Set(config.desktopAppIds || []);
    this.desktopCaptureRequiresConfirmation = config.desktopCaptureRequiresConfirmation !== false;
    for (const writeRoot of this.allowedWriteRoots) {
      if (!this.allowedReadRoots.some((readRoot) => isWithin(writeRoot, readRoot))) {
        throw new Error(`Allowed write root must be contained by an allowed read root: ${writeRoot}`);
      }
    }
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

    const target = normalized.kind === "command.run" ? normalized.cwd : normalized.path;
    if (
      hasDeniedSegment(target) ||
      isSecretLike(target) ||
      this.deniedPaths.some((deniedPath) => isWithin(target, deniedPath))
    ) {
      return denied(normalized, "DENIED_PATH", `Path is denied by policy: ${target}`);
    }

    if (
      normalized.kind === "file.read" ||
      normalized.kind === "file.list" ||
      normalized.kind === "file.exists"
    ) {
      if (!this.allowedReadRoots.some((root) => isWithin(target, root))) {
        return denied(normalized, "OUTSIDE_READ_ROOTS", `Read path is outside allowed roots: ${target}`);
      }
      return { outcome: "allow", reasonCode: "ALLOWED", reason: "Read path is allowed.", action: normalized };
    }

    if (normalized.kind !== "command.run") {
      if (!isWithin(target, this.workspaceRoot)) {
        return denied(normalized, "OUTSIDE_WORKSPACE", `Write path is outside workspace: ${target}`);
      }
      if (!this.allowedWriteRoots.some((root) => isWithin(target, root))) {
        return denied(normalized, "OUTSIDE_WRITE_ROOTS", `Write path is outside allowed roots: ${target}`);
      }
    } else if (!isWithin(target, this.workspaceRoot)) {
      return denied(normalized, "OUTSIDE_WORKSPACE", `Command cwd is outside workspace: ${target}`);
    }

    const needsConfirmation =
      normalized.kind === "command.run"
        ? normalized.requiresConfirmation || normalized.externalSideEffect
        : true;
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
    if (!(action.kind === "desktop.capture" && !this.desktopCaptureRequiresConfirmation) && !context.confirmationGranted) {
      return {
        outcome: "confirm",
        reasonCode: "CONFIRMATION_REQUIRED",
        reason: `${action.kind} requires explicit confirmation.`,
        action,
      };
    }
    return {
      outcome: "allow",
      reasonCode: "ALLOWED",
      reason: `${action.kind} is allowed by policy.`,
      action,
    };
  }
}
