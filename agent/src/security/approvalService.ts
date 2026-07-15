import crypto from "node:crypto";
import {
  createPendingApproval,
  createApprovalGrant,
  getPendingApproval,
  listActiveApprovalGrants,
  nowIso,
  resolvePendingApproval,
  revokeApprovalGrant,
  setRunStatus,
  finishRun,
  type ApprovalGrantRow,
  type PendingApprovalRow,
} from "../storage/repositories";
import type { ActionProfile } from "./actionProfile";

export type ApprovalScope = "run" | "session" | "schedule" | "persistent";

export class ApprovalService {
  create(input: {
    runId: string;
    principalId: string;
    chatId: string;
    description: string;
    actionDigest: string;
    payload: unknown;
    expiresAt: string;
  }): Pick<PendingApprovalRow, "id" | "short_id"> {
    const id = crypto.randomUUID();
    const shortId = crypto.randomBytes(4).toString("hex");
    createPendingApproval({
      id,
      short_id: shortId,
      run_id: input.runId,
      principal_id: input.principalId,
      chat_id: input.chatId,
      description: input.description,
      action_digest: input.actionDigest,
      payload_json: JSON.stringify(input.payload),
      expires_at: input.expiresAt,
    });
    setRunStatus(input.runId, "waiting_approval");
    return { id, short_id: shortId };
  }

  get(shortId: string, principalId: string, chatId: string): PendingApprovalRow | null {
    return getPendingApproval(shortId, principalId, chatId);
  }

  resolve(input: {
    shortId: string;
    principalId: string;
    chatId: string;
    actionDigest: string;
    approve: boolean;
    scope?: ApprovalScope;
    sessionId?: string;
    scheduleId?: string;
  }): PendingApprovalRow | null {
    const pending = getPendingApproval(input.shortId, input.principalId, input.chatId);
    if (!pending || pending.status !== "pending") return null;
    if (pending.expires_at <= nowIso()) {
      resolvePendingApproval(pending.id, "expired");
      return null;
    }
    if (pending.action_digest !== input.actionDigest) {
      resolvePendingApproval(pending.id, "invalidated");
      return null;
    }
    resolvePendingApproval(pending.id, input.approve ? "approved" : "rejected");
    if (input.approve) {
      const profile = readProfile(pending.payload_json);
      const isBrowser = profile?.family === "browser" || readCallName(pending.payload_json) === "browser";
      // Browser confirmations stay snapshot/fingerprint-bound (browserConfirmationStore);
      // a DB grant must never widen to every browser operation in the scope.
      const commandHints = isBrowser ? [] : (profile?.commandHints || approvalHints(pending.payload_json));
      const scope = input.scope || "run";
      createApprovalGrant({
        id: crypto.randomUUID(),
        principalId: pending.principal_id,
        description: pending.description,
        scope,
        runId: scope === "run" ? pending.run_id : undefined,
        sessionId: scope === "session" ? input.sessionId : undefined,
        scheduleId: scope === "schedule" ? input.scheduleId : undefined,
        riskCategories: profile && !isBrowser ? [profile.riskCategory] : ["approved-action"],
        resourceHints: isBrowser ? undefined : profile?.resourceHints,
        commandHints,
        expiresAt: pending.expires_at,
      });
      setRunStatus(pending.run_id, "running");
    } else finishRun(pending.run_id, "cancelled");
    return pending;
  }

  covers(input: {
    principalId: string;
    runId?: string;
    sessionId?: string;
    scheduleId?: string;
    profile: ActionProfile;
  }): boolean {
    return listActiveApprovalGrants({
      principalId: input.principalId,
      runId: input.runId,
      sessionId: input.sessionId,
      scheduleId: input.scheduleId,
    }).some((grant) => grantMatches(grant, input.profile));
  }

  revoke(grantId: string): void {
    revokeApprovalGrant(grantId);
  }
}

function grantMatches(grant: ApprovalGrantRow, profile: ActionProfile): boolean {
  const riskCats = parseHints(grant.risk_categories_json);
  // Gate 1 — risk: empty grant list or the backward-compat "approved-action"
  // wildcard matches any risk; otherwise the action's risk must be listed.
  const riskOK = riskCats.length === 0 || riskCats.includes("*") || riskCats.includes("approved-action") || riskCats.includes(profile.riskCategory);
  if (!riskOK) return false;

  // Gate 2 — command family: empty grant hints NEVER match. This is what keeps
  // a browser confirmation (which stores no commandHints) from widening into a
  // general grant. "*" or an overlap with the action's commandHints is required.
  const cmdHints = parseHints(grant.command_hints_json);
  const cmdOK = cmdHints.includes("*") || cmdHints.some((hint) => profile.commandHints.includes(hint));
  if (!cmdOK) return false;

  // Gate 3 — resource area: empty grant hints match all (backward-compat with
  // grants that never captured a resource). "*" or overlap otherwise.
  const resHints = parseHints(grant.resource_hints_json);
  return resHints.length === 0 || resHints.includes("*") || resHints.some((hint) => profile.resourceHints.includes(hint));
}

function parseHints(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function approvalHints(payloadJson: string): string[] {
  try {
    const payload = JSON.parse(payloadJson) as { action?: { name?: unknown }; call?: { name?: unknown } };
    // Browser confirmation is bound to snapshot/action fingerprints and is
    // intentionally consumed as an exact action grant, not widened to every
    // browser operation in the run.
    if (typeof payload.call?.name === "string") return payload.call.name === "browser" ? [] : [payload.call.name];
    if (typeof payload.action?.name === "string") return [`command.${payload.action.name}`];
  } catch {
    // A malformed payload cannot broaden an approval grant.
  }
  return [];
}

function readProfile(payloadJson: string): ActionProfile | undefined {
  try {
    const payload = JSON.parse(payloadJson) as { profile?: ActionProfile };
    return payload.profile;
  } catch {
    return undefined;
  }
}

function readCallName(payloadJson: string): string | undefined {
  try {
    const payload = JSON.parse(payloadJson) as { call?: { name?: unknown } };
    return typeof payload.call?.name === "string" ? payload.call.name : undefined;
  } catch {
    return undefined;
  }
}
