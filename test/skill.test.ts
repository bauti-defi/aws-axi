/**
 * Tests for the skill generator — verifies createSkillMarkdown produces
 * correct output and that the drift check (--check mode) behaves correctly.
 */
import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { createSkillMarkdown, SKILL_DESCRIPTION } from "../src/skill.js";

// ---------------------------------------------------------------------------
// createSkillMarkdown structure
// ---------------------------------------------------------------------------

describe("createSkillMarkdown", () => {
  it("includes YAML frontmatter with name aws-axi", () => {
    const md = createSkillMarkdown();
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("name: aws-axi");
  });

  it("includes description field in frontmatter", () => {
    const md = createSkillMarkdown();
    expect(md).toContain('description:');
    expect(md).toContain("aws");
  });

  it("includes the commands block from TOP_HELP", () => {
    const md = createSkillMarkdown();
    // TOP_HELP contains a commands[N]: block — it must appear in the skill
    expect(md).toMatch(/commands\[\d+\]:/);
  });

  it("includes setup in the commands block", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("setup");
  });

  it("contains npx invocation hint", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("npx -y aws-axi");
  });

  it("is deterministic — two calls produce identical output", () => {
    expect(createSkillMarkdown()).toBe(createSkillMarkdown());
  });

  it("closes frontmatter before body", () => {
    const md = createSkillMarkdown();
    // Must have exactly two --- delimiters for valid frontmatter
    const fences = md.split("\n").filter((l) => l === "---");
    expect(fences.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// SKILL_DESCRIPTION
// ---------------------------------------------------------------------------

describe("SKILL_DESCRIPTION", () => {
  it("is non-empty", () => {
    expect(SKILL_DESCRIPTION.length).toBeGreaterThan(20);
  });

  it("mentions AWS", () => {
    expect(SKILL_DESCRIPTION.toLowerCase()).toContain("aws");
  });
});

// ---------------------------------------------------------------------------
// build-skill --check mode
// ---------------------------------------------------------------------------

describe("build-skill --check mode", () => {
  it("exits 0 when committed SKILL.md matches generated output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-skill-check-"));
    const skillsDir = join(tmp, "skills", "aws-axi");
    mkdirSync(skillsDir, { recursive: true });

    const expected = createSkillMarkdown();
    writeFileSync(join(skillsDir, "SKILL.md"), expected, "utf-8");

    // Invoke the build-skill script in --check mode by running it as a subprocess
    const result = await Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "scripts", "build-skill.ts"), "--check"],
      {
        env: {
          ...process.env,
          SKILL_DIR_OVERRIDE: skillsDir,
        },
        cwd: join(import.meta.dir, ".."),
      },
    );

    expect(result.exitCode).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 1 when committed SKILL.md is stale", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-skill-check-"));
    const skillsDir = join(tmp, "skills", "aws-axi");
    mkdirSync(skillsDir, { recursive: true });

    writeFileSync(join(skillsDir, "SKILL.md"), "STALE CONTENT\n", "utf-8");

    const result = await Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "scripts", "build-skill.ts"), "--check"],
      {
        env: {
          ...process.env,
          SKILL_DIR_OVERRIDE: skillsDir,
        },
        cwd: join(import.meta.dir, ".."),
      },
    );

    expect(result.exitCode).toBe(1);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 1 when SKILL.md is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-skill-check-"));
    const skillsDir = join(tmp, "skills", "aws-axi");
    mkdirSync(skillsDir, { recursive: true });
    // No SKILL.md written — intentionally absent

    const result = await Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "scripts", "build-skill.ts"), "--check"],
      {
        env: {
          ...process.env,
          SKILL_DIR_OVERRIDE: skillsDir,
        },
        cwd: join(import.meta.dir, ".."),
      },
    );

    expect(result.exitCode).toBe(1);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes SKILL.md in write mode and it matches expected content", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-skill-write-"));
    const skillsDir = join(tmp, "skills", "aws-axi");
    mkdirSync(skillsDir, { recursive: true });

    await Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "scripts", "build-skill.ts")],
      {
        env: {
          ...process.env,
          SKILL_DIR_OVERRIDE: skillsDir,
        },
        cwd: join(import.meta.dir, ".."),
      },
    );

    const written = readFileSync(join(skillsDir, "SKILL.md"), "utf-8");
    expect(written).toBe(createSkillMarkdown());
    rmSync(tmp, { recursive: true, force: true });
  });
});
