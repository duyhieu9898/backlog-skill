"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillRegistry = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("../config/paths");
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
class SkillRegistry {
    rootDir;
    skills;
    constructor(rootDir = paths_1.skillsDir) {
        this.rootDir = rootDir;
        this.skills = this.scan();
    }
    listSkills() {
        return [...this.skills].sort((a, b) => a.slug.localeCompare(b.slug));
    }
    getSkill(slug) {
        return this.skills.find((skill) => skill.slug === slug);
    }
    loadSkillContent(slug, maxBytes) {
        const skill = this.getSkill(slug);
        if (!skill)
            return null;
        const content = node_fs_1.default.readFileSync(skill.skillPath, "utf8");
        if (!maxBytes || Buffer.byteLength(content, "utf8") <= maxBytes)
            return content;
        return `${content.slice(0, maxBytes)}\n[truncated: showing first ${maxBytes} bytes of SKILL.md]`;
    }
    findLikelySkill(text) {
        const lower = text.toLowerCase();
        return this.listSkills().find((skill) => {
            const haystack = `${skill.slug} ${skill.name} ${skill.description}`.toLowerCase();
            return haystack
                .split(/[^a-z0-9_-]+/i)
                .filter((word) => word.length >= 3)
                .some((word) => lower.includes(word));
        });
    }
    scan() {
        if (!node_fs_1.default.existsSync(this.rootDir))
            return [];
        return node_fs_1.default
            .readdirSync(this.rootDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
            const slug = entry.name;
            const baseDir = node_path_1.default.join(this.rootDir, slug);
            const skillPath = node_path_1.default.join(baseDir, "SKILL.md");
            if (!node_fs_1.default.existsSync(skillPath))
                return null;
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
        })
            .filter((skill) => Boolean(skill));
    }
}
exports.SkillRegistry = SkillRegistry;
