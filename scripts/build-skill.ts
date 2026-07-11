// Generates skills/aws-axi/SKILL.md from the shared CLI guidance so the
// installable skill never drifts from what `aws-axi` prints.
//
//   bun run build:skill            # write the file
//   bun run build:skill -- --check # fail (exit 1) if the committed file is stale
//
// SKILL_DIR_OVERRIDE env var redirects the target directory — used by tests
// to write/check into a temp dir without touching the committed file.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createSkillMarkdown } from "../src/skill.js";

const expected = createSkillMarkdown();
const check = process.argv.includes("--check");

// Resolve the target directory: use the override env var when set (tests),
// otherwise default to the committed skills/aws-axi/ directory.
const targetDir: string =
  process.env["SKILL_DIR_OVERRIDE"] !== undefined
    ? process.env["SKILL_DIR_OVERRIDE"]
    : fileURLToPath(new URL("../skills/aws-axi/", import.meta.url));

const target = join(targetDir, "SKILL.md");

if (check) {
  let actual: string | null = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // missing file → falls through to mismatch branch
  }
  if (actual !== expected) {
    console.error(
      "skills/aws-axi/SKILL.md is out of date. Run `bun run build:skill` and commit the result.",
    );
    process.exit(1);
  }
  console.log("skills/aws-axi/SKILL.md is up to date.");
} else {
  await mkdir(targetDir, { recursive: true });
  await writeFile(target, expected, "utf-8");
  console.log(`Wrote ${target}`);
}
