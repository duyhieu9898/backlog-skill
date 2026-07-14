import fs from "node:fs";
import path from "node:path";

import { skillsDir } from "../config/paths";

export type SkillMetadata = {
  slug: string;
  name: string;
  description: string;
  baseDir: string;
  skillPath: string;
};

export type SkillRegistryError = {
  slug: string;
  skillPath: string;
  message: string;
};

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
  "thu",
  "tool",
  "tools",
  "using",
  "voi",
]);

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (item) values[item[1]] = item[2].replace(/^["']|["']$/g, "").trim();
  }
  return values;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !MATCH_STOP_WORDS.has(word)),
  );
}

function includesPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}

function truncateUtf8(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  const prefix = bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/g, "");
  return `${prefix}\n[truncated: showing first ${maxBytes} bytes of SKILL.md]`;
}

export class SkillRegistry {
  private skills: SkillMetadata[];
  private readonly errors: SkillRegistryError[] = [];

  constructor(private readonly rootDir = skillsDir) {
    this.skills = this.scan();
  }

  listSkills(): SkillMetadata[] {
    return [...this.skills].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  listErrors(): SkillRegistryError[] {
    return [...this.errors].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  getSkill(slug: string): SkillMetadata | undefined {
    return this.skills.find((skill) => skill.slug === slug);
  }

  loadSkillContent(slug: string, maxBytes?: number): string | null {
    const skill = this.getSkill(slug);
    if (!skill) return null;
    try {
      const content = fs.readFileSync(skill.skillPath, "utf8").replaceAll("{baseDir}", skill.baseDir);
      return maxBytes ? truncateUtf8(content, maxBytes) : content;
    } catch (error) {
      this.recordError(skill.slug, skill.skillPath, error);
      return null;
    }
  }

  findLikelySkill(text: string): SkillMetadata | undefined {
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

        if (includesPhrase(normalizedQuery, slug)) score += 1_000 + slug.length;
        if (name !== slug && includesPhrase(normalizedQuery, name)) score += 800 + name.length;

        for (const token of queryTokens) {
          if (slugTokens.has(token)) score += 40;
          if (nameTokens.has(token)) score += 20;
          if (descriptionTokens.has(token)) score += 5;
        }
        return { skill, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug));

    if (!candidates.length) return undefined;
    if (candidates[1]?.score === candidates[0].score) return undefined;
    return candidates[0].skill;
  }

  private scan(): SkillMetadata[] {
    if (!fs.existsSync(this.rootDir)) {
      this.recordError("registry", this.rootDir, new Error("Skills directory does not exist"));
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch (error) {
      this.recordError("registry", this.rootDir, error);
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const slug = entry.name;
        const baseDir = path.join(this.rootDir, slug);
        const skillPath = path.join(baseDir, "SKILL.md");
        if (!fs.existsSync(skillPath)) return null;

        try {
          const metadata = parseFrontmatter(fs.readFileSync(skillPath, "utf8"));
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
        } catch (error) {
          this.recordError(slug, skillPath, error);
          return null;
        }
      })
      .filter((skill): skill is SkillMetadata => Boolean(skill));
  }

  private recordError(slug: string, skillPath: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const duplicate = this.errors.some(
      (item) => item.slug === slug && item.skillPath === skillPath && item.message === message,
    );
    if (!duplicate) this.errors.push({ slug, skillPath, message });
  }
}
