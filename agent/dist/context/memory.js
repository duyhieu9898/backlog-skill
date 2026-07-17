"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieveMemory = retrieveMemory;
exports.retrieveMemoryFromSources = retrieveMemoryFromSources;
exports.retrieveRelevantDurableMemory = retrieveRelevantDurableMemory;
exports.flushCheckpointToDailyMemory = flushCheckpointToDailyMemory;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("../config/paths");
const token_estimate_1 = require("./token-estimate");
function terms(text) {
    return new Set(text.toLocaleLowerCase("vi-VN").match(/[\p{L}\p{N}_-]{2,}/gu) || []);
}
function retrieveMemory(query, source, maxTokens) {
    if (maxTokens <= 0)
        return [];
    const queryTerms = terms(query);
    if (queryTerms.size === 0)
        return [];
    const chunks = source
        .split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0 && !/^#\s/.test(chunk));
    const ranked = chunks
        .map((chunk, index) => ({
        chunk,
        index,
        score: [...terms(chunk)].reduce((score, term) => score + (queryTerms.has(term) ? 1 : 0), 0),
    }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = [];
    let used = 0;
    for (const item of ranked) {
        const tokens = (0, token_estimate_1.estimateTokens)(item.chunk);
        if (selected.length > 0 && used + tokens > maxTokens)
            continue;
        selected.push(item.chunk);
        used += tokens;
    }
    return selected;
}
function retrieveMemoryFromSources(query, sources, maxTokens) {
    const results = [];
    let remaining = maxTokens;
    for (const source of sources) {
        if (remaining <= 0)
            break;
        for (const hit of retrieveMemory(query, source, remaining)) {
            const tokens = (0, token_estimate_1.estimateTokens)(hit);
            if (results.length > 0 && tokens > remaining)
                continue;
            results.push(hit);
            remaining -= tokens;
        }
    }
    return results;
}
function retrieveRelevantDurableMemory(query, maxTokens) {
    const sources = [];
    if (node_fs_1.default.existsSync(paths_1.memoryFile))
        sources.push(node_fs_1.default.readFileSync(paths_1.memoryFile, "utf8"));
    if (node_fs_1.default.existsSync(paths_1.memoryDir)) {
        const dailyFiles = node_fs_1.default.readdirSync(paths_1.memoryDir)
            .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
            .sort()
            .reverse();
        for (const name of dailyFiles)
            sources.push(node_fs_1.default.readFileSync(node_path_1.default.join(paths_1.memoryDir, name), "utf8"));
    }
    return retrieveMemoryFromSources(query, sources, maxTokens);
}
/**
 * A deterministic pre-compaction flush. Curated MEMORY.md stays human-owned;
 * checkpoint facts go to dated working notes and are never wholesale-injected.
 */
function flushCheckpointToDailyMemory(checkpoint, now = new Date(), targetDir = paths_1.memoryDir) {
    const facts = [
        ...checkpoint.decisions.map((item) => `Decision: ${item.decision}${item.rationale ? ` (${item.rationale})` : ""}`),
        ...checkpoint.importantIdentifiers.map((item) => `Identifier: ${item}`),
        ...(checkpoint.decisions.length || checkpoint.importantIdentifiers.length
            ? checkpoint.criticalContext.map((item) => `Context: ${item}`)
            : []),
    ].filter(Boolean);
    if (facts.length === 0)
        return null;
    const date = now.toISOString().slice(0, 10);
    const file = node_path_1.default.join(targetDir, `${date}.md`);
    node_fs_1.default.mkdirSync(targetDir, { recursive: true });
    const block = `\n## Compaction checkpoint\n${facts.map((fact) => `- ${fact}`).join("\n")}\n`;
    const existing = node_fs_1.default.existsSync(file) ? node_fs_1.default.readFileSync(file, "utf8") : "# Working memory\n";
    if (!existing.includes(block.trim()))
        node_fs_1.default.writeFileSync(file, `${existing.trimEnd()}${block}`, "utf8");
    return file;
}
