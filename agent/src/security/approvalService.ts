import crypto from "node:crypto";
import {
  createPendingApproval,
  createApprovalGrant,
  getPendingApproval,
  listActiveApprovalGrants,
  nowIso,
  resolvePendingApproval,
  setRunStatus,
  finishRun,
  type PendingApprovalRow,
} from "../storage/repositories";

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

  resolve(input: { shortId: string; principalId: string; chatId: string; actionDigest: string; approve: boolean }): PendingApprovalRow | null {
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
      const hints = approvalHints(pending.payload_json);
      createApprovalGrant({
        id: crypto.randomUUID(),
        principalId: pending.principal_id,
        description: pending.description,
        scope: "run",
        runId: pending.run_id,
        riskCategories: ["approved-action"],
        commandHints: hints,
        expiresAt: pending.expires_at,
      });
      setRunStatus(pending.run_id, "running");
    } else finishRun(pending.run_id, "cancelled");
    return pending;
  }

  covers(input: { principalId: string; runId: string; actionKey: string }): boolean {
    return listActiveApprovalGrants({ principalId: input.principalId, runId: input.runId }).some((grant) => {
      const hints = parseHints(grant.command_hints_json);
      return hints.includes(input.actionKey) || hints.includes("*");
    });
  }
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
