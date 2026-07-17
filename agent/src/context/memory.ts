import fs from "node:fs";

import path from "node:path";

import { memoryDir, memoryFile } from "../config/paths";
import type { ContextCheckpoint } from "./checkpoint";
import { estimateTokens } from "./token-estimate";

function terms(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase("vi-VN").match(/[\p{L}\p{N}_-]{2,}/gu) || []);
}

export function retrieveMemory(query: string, source: string, maxTokens: number): string[] {
  if (maxTokens <= 0) return [];
  const queryTerms = terms(query);
  if (queryTerms.size === 0) return [];
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
  const selected: string[] = [];
  let used = 0;
  for (const item of ranked) {
    const tokens = estimateTokens(item.chunk);
    if (selected.length > 0 && used + tokens > maxTokens) continue;
    selected.push(item.chunk);
    used += tokens;
  }
  return selected;
}

export function retrieveMemoryFromSources(query: string, sources: string[], maxTokens: number): string[] {
  const results: string[] = [];
  let remaining = maxTokens;
  for (const source of sources) {
    if (remaining <= 0) break;
    for (const hit of retrieveMemory(query, source, remaining)) {
      const tokens = estimateTokens(hit);
      if (results.length > 0 && tokens > remaining) continue;
      results.push(hit);
      remaining -= tokens;
    }
  }
  return results;
}

export function retrieveRelevantDurableMemory(query: string, maxTokens: number): string[] {
  const sources: string[] = [];
  if (fs.existsSync(memoryFile)) sources.push(fs.readFileSync(memoryFile, "utf8"));
  if (fs.existsSync(memoryDir)) {
    const dailyFiles = fs.readdirSync(memoryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .reverse();
    for (const name of dailyFiles) sources.push(fs.readFileSync(path.join(memoryDir, name), "utf8"));
  }
  return retrieveMemoryFromSources(query, sources, maxTokens);
}

/**
 * A deterministic pre-compaction flush. Curated MEMORY.md stays human-owned;
 * checkpoint facts go to dated working notes and are never wholesale-injected.
 */
export function flushCheckpointToDailyMemory(checkpoint: ContextCheckpoint, now = new Date(), targetDir = memoryDir): string | null {
  const facts = [
    ...checkpoint.decisions.map((item) => `Decision: ${item.decision}${item.rationale ? ` (${item.rationale})` : ""}`),
    ...checkpoint.importantIdentifiers.map((item) => `Identifier: ${item}`),
    ...(checkpoint.decisions.length || checkpoint.importantIdentifiers.length
      ? checkpoint.criticalContext.map((item) => `Context: ${item}`)
      : []),
  ].filter(Boolean);
  if (facts.length === 0) return null;
  const date = now.toISOString().slice(0, 10);
  const file = path.join(targetDir, `${date}.md`);
  fs.mkdirSync(targetDir, { recursive: true });
  const block = `\n## Compaction checkpoint\n${facts.map((fact) => `- ${fact}`).join("\n")}\n`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Working memory\n";
  if (!existing.includes(block.trim())) fs.writeFileSync(file, `${existing.trimEnd()}${block}`, "utf8");
  return file;
}
