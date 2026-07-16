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
            const profile = readProfile(pending.payload_json);
            const isBrowser = profile?.family === "browser" || readCallName(pending.payload_json) === "browser";
            // Browser confirmations stay snapshot/fingerprint-bound (browserConfirmationStore);
            // a DB grant must never widen to every browser operation in the scope.
            const commandHints = isBrowser ? [] : (profile?.commandHints || approvalHints(pending.payload_json));
            const scope = input.scope || "run";
            (0, repositories_1.createApprovalGrant)({
                id: node_crypto_1.default.randomUUID(),
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
            (0, repositories_1.setRunStatus)(pending.run_id, "running");
        }
        else
            (0, repositories_1.finishRun)(pending.run_id, "cancelled");
        return pending;
    }
    covers(input) {
        return (0, repositories_1.listActiveApprovalGrants)({
            principalId: input.principalId,
            runId: input.runId,
            sessionId: input.sessionId,
            scheduleId: input.scheduleId,
        }).some((grant) => grantMatches(grant, input.profile));
    }
    revoke(grantId) {
        (0, repositories_1.revokeApprovalGrant)(grantId);
    }
    /**
     * Cancel every still-pending approval for a chat (owner `/stop` while a run is
     * paused waiting for confirmation). Each resolved pending is recorded as
     * `invalidated` and its run terminally as `cancelled`. Returns the affected
     * run ids. Idempotent: `resolvePendingApproval` only updates `status='pending'`
     * rows, and we re-read the row before finishing the run so an approval that
     * won a concurrent resolve cannot be overwritten with `cancelled`.
     */
    cancelPendingForChat(chatId, principalId) {
        const rows = (0, repositories_1.listPendingApprovalsByChat)(chatId, principalId);
        const runIds = [];
        for (const row of rows) {
            (0, repositories_1.resolvePendingApproval)(row.id, "invalidated");
            const after = (0, repositories_1.getPendingApproval)(row.short_id, row.principal_id, row.chat_id);
            if (after?.status === "invalidated") {
                (0, repositories_1.finishRun)(row.run_id, "cancelled", "Cancelled by owner.");
                runIds.push(row.run_id);
            }
        }
        return runIds;
    }
}
exports.ApprovalService = ApprovalService;
function grantMatches(grant, profile) {
    const riskCats = parseHints(grant.risk_categories_json);
    // Gate 1 — risk: empty grant list or the backward-compat "approved-action"
    // wildcard matches any risk; otherwise the action's risk must be listed.
    const riskOK = riskCats.length === 0 || riskCats.includes("*") || riskCats.includes("approved-action") || riskCats.includes(profile.riskCategory);
    if (!riskOK)
        return false;
    // Gate 2 — command family: empty grant hints NEVER match. This is what keeps
    // a browser confirmation (which stores no commandHints) from widening into a
    // general grant. "*" or an overlap with the action's commandHints is required.
    const cmdHints = parseHints(grant.command_hints_json);
    const cmdOK = cmdHints.includes("*") || cmdHints.some((hint) => profile.commandHints.includes(hint));
    if (!cmdOK)
        return false;
    // Gate 3 — resource area: empty grant hints match all (backward-compat with
    // grants that never captured a resource). "*" or overlap otherwise.
    const resHints = parseHints(grant.resource_hints_json);
    return resHints.length === 0 || resHints.includes("*") || resHints.some((hint) => profile.resourceHints.includes(hint));
}
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
function readProfile(payloadJson) {
    try {
        const payload = JSON.parse(payloadJson);
        return payload.profile;
    }
    catch {
        return undefined;
    }
}
function readCallName(payloadJson) {
    try {
        const payload = JSON.parse(payloadJson);
        return typeof payload.call?.name === "string" ? payload.call.name : undefined;
    }
    catch {
        return undefined;
    }
}
