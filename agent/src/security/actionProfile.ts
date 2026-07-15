import type { CommandRunAction } from "../tools/contracts";
import type { PreparedToolCall } from "../tools/executor";
import { previewCommand } from "../commands";
import { canonicalizePolicyPath } from "./permissionPolicy";
import { isSecretLike, isClearlyDestructiveCommand, needsSystemApproval } from "./policy-patterns";

/**
 * A contextual description of a prepared tool call, used for approval-grant
 * matching (ADR 0017 P1.2). Matching is contextual rather than exact-argument
 * replay: same family, risk level, and resource area, within a scope.
 */
export type RiskCategory =
  | "routine"
  | "sensitive"
  | "destructive"
  | "external-side-effect"
  | "system-impact"
  | "approved-action";

export type ActionFamily = "file" | "command" | "browser" | "desktop" | "custom";

export interface ActionProfile {
  family: ActionFamily;
  riskCategory: RiskCategory;
  /** Canonical path / cwd / URL origin / appId — the resource area touched. */
  resourceHints: string[];
  /** Tool name or action kind; the command-family axis. */
  commandHints: string[];
}

function safeCanonical(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    return canonicalizePolicyPath(candidate);
  } catch {
    return candidate;
  }
}

function urlOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function commandRisk(prepared: PreparedToolCall): RiskCategory {
  const command = prepared.command!;
  const preview = previewCommand(command);
  const cmdLike = {
    kind: "command.run",
    commandId: command.name || "command.run",
    executable: preview.executable,
    args: preview.args,
    shellCommand: preview.shellCommand,
    cwd: preview.cwd,
    requiresConfirmation: preview.requiresConfirmation,
    externalSideEffect: preview.externalSideEffect,
  } as CommandRunAction;
  if (isClearlyDestructiveCommand(cmdLike)) return "destructive";
  if (needsSystemApproval(cmdLike)) return "system-impact";
  if (preview.externalSideEffect) return "external-side-effect";
  return "routine";
}

/**
 * Derive an {@link ActionProfile} from a prepared tool call. Reuses the same
 * classification primitives as PermissionPolicy so the grant axis matches the
 * policy decision.
 */
export function deriveActionProfile(prepared: PreparedToolCall): ActionProfile {
  if (prepared.command) {
    const preview = previewCommand(prepared.command);
    const cwd = safeCanonical(preview.cwd);
    return {
      family: "command",
      riskCategory: commandRisk(prepared),
      resourceHints: cwd ? [cwd] : [],
      commandHints: [prepared.call.name],
    };
  }

  if (prepared.fileAction) {
    const path = prepared.fileAction.path;
    const canonical = safeCanonical(path);
    return {
      family: "file",
      riskCategory: isSecretLike(path) ? "sensitive" : "routine",
      resourceHints: canonical ? [canonical] : [],
      commandHints: [prepared.call.name],
    };
  }

  if (prepared.desktopAction) {
    const action = prepared.desktopAction;
    return {
      family: "desktop",
      riskCategory: "routine",
      resourceHints: action.kind === "desktop.launch" ? [action.appId] : [],
      commandHints: [action.kind],
    };
  }

  if (prepared.browserAction) {
    const args = prepared.call.arguments as { url?: unknown };
    const origin = urlOrigin(args.url);
    return {
      family: "browser",
      // Browser confirmations stay snapshot/fingerprint-bound; this profile
      // never matches a widened grant because resolve() stores no commandHints
      // for browser actions (approvalHints returns []).
      riskCategory: "approved-action",
      resourceHints: origin ? [origin] : [],
      commandHints: [prepared.browserAction.kind],
    };
  }

  if (prepared.customTool) {
    const risk = prepared.customTool.risk;
    return {
      family: "custom",
      riskCategory: risk === "destructive" ? "destructive" : risk === "sensitive" ? "sensitive" : "routine",
      resourceHints: [],
      commandHints: [prepared.customTool.name],
    };
  }

  return {
    family: "custom",
    riskCategory: "routine",
    resourceHints: [],
    commandHints: prepared.call.name ? [prepared.call.name] : [],
  };
}
