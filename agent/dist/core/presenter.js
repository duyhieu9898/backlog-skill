"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.presentArtifact = presentArtifact;
exports.deliverResponse = deliverResponse;
exports.presentCommandResult = presentCommandResult;
const utils_1 = require("../utils");
const store_1 = require("../artifacts/store");
function presentArtifact(text, artifact) {
    return { text, artifact };
}
async function deliverResponse(channel, chatId, response, replyMarkup, artifacts = new store_1.ArtifactStore()) {
    if (response.artifact) {
        const artifact = artifacts.claim(response.artifact.id, chatId);
        await channel.sendMessage(chatId, response.text, replyMarkup);
        await channel.sendArtifact(chatId, artifact);
        artifacts.markDelivered(artifact.id);
        return;
    }
    await channel.sendMessage(chatId, response.text, replyMarkup);
}
function cleanOutput(output) {
    return output
        .split("\n")
        .filter((line) => {
        const trimmed = line.trim();
        // Loại bỏ boilerplate của npm run/start
        if (trimmed.startsWith("> "))
            return false;
        // Loại bỏ log của thư viện dotenv
        if (trimmed.startsWith("[dotenv@"))
            return false;
        return true;
    })
        .join("\n")
        .trim();
}
function presentCommandResult(input) {
    const cleaned = cleanOutput(input.output);
    const shortOutput = cleaned.length <= 1200 ? cleaned : (0, utils_1.tailLines)(cleaned, 20);
    const truncated = cleaned.length > shortOutput.length ? "\n[truncated: showing latest command output]" : "";
    return [
        input.ok ? `${input.label} thành công` : `${input.label} thất bại`,
        `traceId: ${input.traceId}`,
        input.ok ? "" : `exit: ${input.exit}`,
        "",
        shortOutput ? `${shortOutput}${truncated}` : "(no output)",
    ]
        .filter((line) => line !== "")
        .join("\n");
}
