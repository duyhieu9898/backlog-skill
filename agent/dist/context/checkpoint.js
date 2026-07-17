"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkpointFromSummary = checkpointFromSummary;
exports.checkpointFromModelResponse = checkpointFromModelResponse;
exports.renderCheckpoint = renderCheckpoint;
function checkpointFromSummary(summary, previous) {
    return {
        goals: previous?.goals || [],
        constraints: previous?.constraints || [],
        completed: previous?.completed || [],
        inProgress: previous?.inProgress || [],
        blockers: previous?.blockers || [],
        decisions: previous?.decisions || [],
        nextSteps: previous?.nextSteps || [],
        criticalContext: [...(previous?.criticalContext || []), summary].slice(-12),
        importantIdentifiers: previous?.importantIdentifiers || [],
    };
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}
function decisions(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object")
            return [];
        const candidate = item;
        return typeof candidate.decision === "string" && candidate.decision.trim()
            ? [{ decision: candidate.decision.trim(), ...(typeof candidate.rationale === "string" && candidate.rationale.trim() ? { rationale: candidate.rationale.trim() } : {}) }]
            : [];
    });
}
/** Parse model JSON defensively and retain prior durable state when a section is absent. */
function checkpointFromModelResponse(response, previous) {
    try {
        const parsed = JSON.parse(response);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return checkpointFromSummary(response, previous);
        return {
            goals: strings(parsed.goals).length ? strings(parsed.goals) : previous?.goals || [],
            constraints: strings(parsed.constraints).length ? strings(parsed.constraints) : previous?.constraints || [],
            completed: strings(parsed.completed).length ? strings(parsed.completed) : previous?.completed || [],
            inProgress: strings(parsed.inProgress).length ? strings(parsed.inProgress) : previous?.inProgress || [],
            blockers: strings(parsed.blockers).length ? strings(parsed.blockers) : previous?.blockers || [],
            decisions: decisions(parsed.decisions).length ? decisions(parsed.decisions) : previous?.decisions || [],
            nextSteps: strings(parsed.nextSteps).length ? strings(parsed.nextSteps) : previous?.nextSteps || [],
            criticalContext: strings(parsed.criticalContext).length ? strings(parsed.criticalContext) : previous?.criticalContext || [],
            importantIdentifiers: strings(parsed.importantIdentifiers).length ? strings(parsed.importantIdentifiers) : previous?.importantIdentifiers || [],
        };
    }
    catch {
        return checkpointFromSummary(response, previous);
    }
}
function renderCheckpoint(checkpoint) {
    const section = (title, entries) => entries.length ? `## ${title}\n${entries.map((entry) => `- ${entry}`).join("\n")}` : "";
    return [
        section("Goal", checkpoint.goals),
        section("Constraints & Preferences", checkpoint.constraints),
        section("Done", checkpoint.completed),
        section("In Progress", checkpoint.inProgress),
        section("Blocked", checkpoint.blockers),
        section("Key Decisions", checkpoint.decisions.map((item) => item.rationale ? `${item.decision} — ${item.rationale}` : item.decision)),
        section("Next Steps", checkpoint.nextSteps),
        section("Critical Context", checkpoint.criticalContext),
        section("Important Identifiers", checkpoint.importantIdentifiers),
    ].filter(Boolean).join("\n\n");
}
