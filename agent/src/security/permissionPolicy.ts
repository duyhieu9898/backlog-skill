import fs from "node:fs";
import path from "node:path";

import type {
  NormalizedToolAction,
  PolicyDecision,
  ToolAction,
} from "../tools/contracts";

export type PermissionPolicyConfig = {
  workspaceRoot: string;
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  deniedPaths: string[];
};

export type PermissionContext = {
  confirmationGranted?: boolean;
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
  return { ...action, path: canonicalizePolicyPath(action.path) };
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

  constructor(config: PermissionPolicyConfig) {
    this.workspaceRoot = canonicalizePolicyPath(config.workspaceRoot);
    this.allowedReadRoots = normalizeRoots(config.allowedReadRoots);
    this.allowedWriteRoots = normalizeRoots(config.allowedWriteRoots);
    this.deniedPaths = normalizeRoots(config.deniedPaths);
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
}
