"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApprovalService = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const repositories_1 = require("../storage/repositories");
class ApprovalService {
    create(input) {
        const id = node_crypto_1.default.randomUUID();
        const shortId = node_crypto_1.default.randomBytes(4).toString("hex");
        (0, repositories_1.createPendingApproval)({
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
        (0, repositories_1.setRunStatus)(input.runId, "waiting_approval");
        return { id, short_id: shortId };
    }
    get(shortId, principalId, chatId) {
        return (0, repositories_1.getPendingApproval)(shortId, principalId, chatId);
    }
    resolve(input) {
        const pending = (0, repositories_1.getPendingApproval)(input.shortId, input.principalId, input.chatId);
        if (!pending || pending.status !== "pending")
            return null;
        if (pending.expires_at <= (0, repositories_1.nowIso)()) {
            (0, repositories_1.resolvePendingApproval)(pending.id, "expired");
            return null;
        }
        if (pending.action_digest !== input.actionDigest) {
            (0, repositories_1.resolvePendingApproval)(pending.id, "invalidated");
            return null;
        }
        (0, repositories_1.resolvePendingApproval)(pending.id, input.approve ? "approved" : "rejected");
        if (input.approve) {
            const hints = approvalHints(pending.payload_json);
            (0, repositories_1.createApprovalGrant)({
                id: node_crypto_1.default.randomUUID(),
                principalId: pending.principal_id,
                description: pending.description,
                scope: "run",
                runId: pending.run_id,
                riskCategories: ["approved-action"],
                commandHints: hints,
                expiresAt: pending.expires_at,
            });
            (0, repositories_1.setRunStatus)(pending.run_id, "running");
        }
        else
            (0, repositories_1.finishRun)(pending.run_id, "cancelled");
        return pending;
    }
    covers(input) {
        return (0, repositories_1.listActiveApprovalGrants)({ principalId: input.principalId, runId: input.runId }).some((grant) => {
            const hints = parseHints(grant.command_hints_json);
            return hints.includes(input.actionKey) || hints.includes("*");
        });
    }
}
exports.ApprovalService = ApprovalService;
function parseHints(value) {
    try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
    }
    catch {
        return [];
    }
}
function approvalHints(payloadJson) {
    try {
        const payload = JSON.parse(payloadJson);
        // Browser confirmation is bound to snapshot/action fingerprints and is
        // intentionally consumed as an exact action grant, not widened to every
        // browser operation in the run.
        if (typeof payload.call?.name === "string")
            return payload.call.name === "browser" ? [] : [payload.call.name];
        if (typeof payload.action?.name === "string")
            return [`command.${payload.action.name}`];
    }
    catch {
        // A malformed payload cannot broaden an approval grant.
    }
    return [];
}
