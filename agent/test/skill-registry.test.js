const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { ContextHydrator } = require("../dist/context/hydrator");
const { handleDebugCommand } = require("../dist/core/debugCommands");
const { SkillRegistry } = require("../dist/skills/registry");

const repoSkillsDir = path.join(__dirname, "..", "..", "skills");

function writeSkill(root, slug, frontmatter, body = "# Skill\n") {
  const baseDir = path.join(root, slug);
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return baseDir;
}

test("SkillRegistry scans current repository skills with stable metadata", () => {
  const registry = new SkillRegistry(repoSkillsDir);
  const skills = registry.listSkills();

  assert.deepEqual(skills.map((skill) => skill.slug), ["bemo", "gmail", "linux-janitor"]);
  assert.equal(registry.listErrors().length, 0);
  for (const skill of skills) {
    assert.equal(path.isAbsolute(skill.baseDir), true);
    assert.equal(skill.skillPath, path.join(skill.baseDir, "SKILL.md"));
    assert.ok(skill.description);
  }
});

test("SkillRegistry keeps valid skills and reports invalid frontmatter", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-"));
  writeSkill(root, "good", "name: Good\ndescription: A valid focused skill.");
  writeSkill(root, "bad", "name: Bad");

  const registry = new SkillRegistry(root);

  assert.deepEqual(registry.listSkills().map((skill) => skill.slug), ["good"]);
  assert.equal(registry.listErrors().length, 1);
  assert.match(registry.listErrors()[0].message, /missing description/);
  assert.match(handleDebugCommand("/status", registry), /skill registry errors: 1/);
  assert.match(handleDebugCommand("/skills", registry), /bad: Skill bad missing description/);
});

test("SkillRegistry reports a missing skills root without crashing", () => {
  const root = path.join(os.tmpdir(), `missing-skills-${Date.now()}`);
  const registry = new SkillRegistry(root);

  assert.deepEqual(registry.listSkills(), []);
  assert.match(registry.listErrors()[0].message, /does not exist/);
});

test("SkillRegistry matches specific slug, name, and description terms", () => {
  const registry = new SkillRegistry(repoSkillsDir);

  assert.equal(registry.findLikelySkill("checkout attendance trên Bemo").slug, "bemo");
  assert.equal(registry.findLikelySkill("dọn unread bằng Gmail Cleanup").slug, "gmail");
  assert.equal(registry.findLikelySkill("kiểm tra Linux disk usage").slug, "linux-janitor");
  assert.equal(registry.findLikelySkill("run local script"), undefined);
});

test("SkillRegistry does not guess when metadata matches are tied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-"));
  writeSkill(root, "one", "description: Cleanup temporary data.");
  writeSkill(root, "two", "description: Cleanup cached data.");

  assert.equal(new SkillRegistry(root).findLikelySkill("cleanup data"), undefined);
});

test("SkillRegistry expands baseDir only when selected content is loaded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-"));
  const baseDir = writeSkill(
    root,
    "docs",
    "description: Inspect project documentation.",
    "Read {baseDir}/README.md\n",
  );
  const registry = new SkillRegistry(root);

  assert.equal(registry.listSkills()[0].description, "Inspect project documentation.");
  assert.match(registry.loadSkillContent("docs"), new RegExp(`${baseDir}/README\\.md`));
  assert.match(registry.loadSkillContent("docs", 20), /truncated: showing first 20 bytes/);
});

test("ContextHydrator loads instructions only for a selected skill", () => {
  const registry = new SkillRegistry(repoSkillsDir);
  const hydrator = new ContextHydrator(registry);
  const message = {
    traceId: "skill-context",
    provider: "telegram",
    chatId: `skill-context-${Date.now()}`,
    userId: "user",
    text: "checkout attendance trên Bemo",
    timestamp: new Date(),
  };

  const selected = hydrator.hydrate(message);
  const general = hydrator.hydrate({ ...message, text: "xin chào" });

  assert.match(selected.prompt.selectedSkill.instructions, /# Bemo Automation/);
  assert.match(selected.prompt.selectedSkill.instructions, new RegExp(path.resolve(repoSkillsDir, "bemo")));
  assert.equal(selected.prompt.toolScope.skillSlug, "bemo");
  assert.equal(general.prompt.selectedSkill, undefined);
  assert.equal(general.prompt.toolScope, undefined);
});

test("default SkillRegistry resolves repository skills outside the service cwd", () => {
  const registryModule = path.join(__dirname, "..", "dist", "skills", "registry.js");
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `const { SkillRegistry } = require(${JSON.stringify(registryModule)});` +
        "process.stdout.write(JSON.stringify(new SkillRegistry().listSkills()));",
    ],
    { cwd: os.tmpdir(), encoding: "utf8" },
  );
  const skills = JSON.parse(output);

  assert.deepEqual(skills.map((skill) => skill.slug), ["bemo", "gmail", "linux-janitor"]);
  assert.ok(skills.every((skill) => skill.baseDir.startsWith(path.resolve(repoSkillsDir))));
});
