"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillRegistry = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("../config/paths");
const MATCH_STOP_WORDS = new Set([
    "agent",
    "and",
    "automation",
    "bang",
    "cho",
    "command",
    "dung",
    "from",
    "helper",
    "local",
    "manage",
    "script",
    "scripts",
    "skill",
    "the",
    "this",
    "tool",
    "tools",
    "using",
    "voi",
]);
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match)
        return {};
    const values = {};
    for (const line of match[1].split(/\r?\n/)) {
        const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (item)
            values[item[1]] = item[2].replace(/^["']|["']$/g, "").trim();
    }
    return values;
}
function normalizeText(value) {
    return value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}
function tokens(value) {
    return new Set(normalizeText(value)
        .split(/\s+/)
        .filter((word) => word.length >= 3 && !MATCH_STOP_WORDS.has(word)));
}
function includesPhrase(text, phrase) {
    return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}
function truncateUtf8(content, maxBytes) {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length <= maxBytes)
        return content;
    const prefix = bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/g, "");
    return `${prefix}\n[truncated: showing first ${maxBytes} bytes of SKILL.md]`;
}
class SkillRegistry {
    rootDir;
    skills;
    errors = [];
    constructor(rootDir = paths_1.skillsDir) {
        this.rootDir = rootDir;
        this.skills = this.scan();
    }
    listSkills() {
        return [...this.skills].sort((a, b) => a.slug.localeCompare(b.slug));
    }
    listErrors() {
        return [...this.errors].sort((a, b) => a.slug.localeCompare(b.slug));
    }
    getSkill(slug) {
        return this.skills.find((skill) => skill.slug === slug);
    }
    loadSkillContent(slug, maxBytes) {
        const skill = this.getSkill(slug);
        if (!skill)
            return null;
        try {
            const content = node_fs_1.default.readFileSync(skill.skillPath, "utf8").replaceAll("{baseDir}", skill.baseDir);
            return maxBytes ? truncateUtf8(content, maxBytes) : content;
        }
        catch (error) {
            this.recordError(skill.slug, skill.skillPath, error);
            return null;
        }
    }
    findLikelySkill(text) {
        const normalizedQuery = normalizeText(text);
        const queryTokens = tokens(text);
        const candidates = this.listSkills()
            .map((skill) => {
            const slug = normalizeText(skill.slug);
            const name = normalizeText(skill.name);
            const slugTokens = tokens(skill.slug);
            const nameTokens = tokens(skill.name);
            const descriptionTokens = tokens(skill.description);
            let score = 0;
            if (includesPhrase(normalizedQuery, slug))
                score += 1_000 + slug.length;
            if (name !== slug && includesPhrase(normalizedQuery, name))
                score += 800 + name.length;
            for (const token of queryTokens) {
                if (slugTokens.has(token))
                    score += 40;
                if (nameTokens.has(token))
                    score += 20;
                if (descriptionTokens.has(token))
                    score += 5;
            }
            return { skill, score };
        })
            .filter((candidate) => candidate.score > 0)
            .sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug));
        if (!candidates.length)
            return undefined;
        if (candidates[1]?.score === candidates[0].score)
            return undefined;
        return candidates[0].skill;
    }
    scan() {
        if (!node_fs_1.default.existsSync(this.rootDir)) {
            this.recordError("registry", this.rootDir, new Error("Skills directory does not exist"));
            return [];
        }
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(this.rootDir, { withFileTypes: true });
        }
        catch (error) {
            this.recordError("registry", this.rootDir, error);
            return [];
        }
        return entries
            .filter((entry) => entry.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entry) => {
            const slug = entry.name;
            const baseDir = node_path_1.default.join(this.rootDir, slug);
            const skillPath = node_path_1.default.join(baseDir, "SKILL.md");
            if (!node_fs_1.default.existsSync(skillPath))
                return null;
            try {
                const metadata = parseFrontmatter(node_fs_1.default.readFileSync(skillPath, "utf8"));
                if (!metadata.description) {
                    throw new Error(`Skill ${slug} missing description in frontmatter`);
                }
                return {
                    slug,
                    name: metadata.name || slug,
                    description: metadata.description,
                    baseDir,
                    skillPath,
                };
            }
            catch (error) {
                this.recordError(slug, skillPath, error);
                return null;
            }
        })
            .filter((skill) => Boolean(skill));
    }
    recordError(slug, skillPath, error) {
        const message = error instanceof Error ? error.message : String(error);
        const duplicate = this.errors.some((item) => item.slug === slug && item.skillPath === skillPath && item.message === message);
        if (!duplicate)
            this.errors.push({ slug, skillPath, message });
    }
}
exports.SkillRegistry = SkillRegistry;
