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

export class SkillRegistry {
  private skills: SkillMetadata[];

  constructor(private readonly rootDir = skillsDir) {
    this.skills = this.scan();
  }

  listSkills(): SkillMetadata[] {
    return [...this.skills].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  getSkill(slug: string): SkillMetadata | undefined {
    return this.skills.find((skill) => skill.slug === slug);
  }

  loadSkillContent(slug: string, maxBytes?: number): string | null {
    const skill = this.getSkill(slug);
    if (!skill) return null;
    const content = fs.readFileSync(skill.skillPath, "utf8");
    if (!maxBytes || Buffer.byteLength(content, "utf8") <= maxBytes) return content;
    return `${content.slice(0, maxBytes)}\n[truncated: showing first ${maxBytes} bytes of SKILL.md]`;
  }

  findLikelySkill(text: string): SkillMetadata | undefined {
    const lower = text.toLowerCase();
    return this.listSkills().find((skill) => {
      const haystack = `${skill.slug} ${skill.name} ${skill.description}`.toLowerCase();
      return haystack
        .split(/[^a-z0-9_-]+/i)
        .filter((word) => word.length >= 3)
        .some((word) => lower.includes(word));
    });
  }

  private scan(): SkillMetadata[] {
    if (!fs.existsSync(this.rootDir)) return [];

    return fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const slug = entry.name;
        const baseDir = path.join(this.rootDir, slug);
        const skillPath = path.join(baseDir, "SKILL.md");
        if (!fs.existsSync(skillPath)) return null;

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
      })
      .filter((skill): skill is SkillMetadata => Boolean(skill));
  }
}
