#!/usr/bin/env bun
/**
 * Verify that the built dist/ output is complete and runnable.
 *
 * Checks:
 *   1. dist/bin/aws-axi.js exists (the bundled Bun module)
 *   2. dist/bin/aws-axi (the POSIX sh launcher) exists
 *   3. Launcher first line is exactly "#!/bin/sh"
 *   4. Launcher has the owner-execute bit set
 *   5. Launcher contains "--no-env-file" (the .env isolation guard — do not remove)
 *   6. Running dist/bin/aws-axi with --version prints the version from package.json
 *
 * Exit 0 on success, exit 1 on any failure.
 *
 * Usage:
 *   bun run verify:dist              # via package.json script
 *   bun run scripts/verify-dist.ts
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DIST_JS = join(ROOT, "dist", "bin", "aws-axi.js");
const DIST_LAUNCHER = join(ROOT, "dist", "bin", "aws-axi");
const PACKAGE_JSON = join(ROOT, "package.json");

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as {
  version: string;
};
const expectedVersion: string = pkg.version;

let allPassed = true;

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string): void {
  console.error(`  ✗ ${msg}`);
  allPassed = false;
}

// 1. Bundled JS module exists
if (existsSync(DIST_JS)) {
  pass(`dist/bin/aws-axi.js exists`);
} else {
  fail(`dist/bin/aws-axi.js does not exist — run \`bun run build\` first`);
}

// 2–5. Launcher checks
if (existsSync(DIST_LAUNCHER)) {
  pass(`dist/bin/aws-axi (launcher) exists`);

  const contents = readFileSync(DIST_LAUNCHER, "utf-8");
  const firstLine = contents.split("\n")[0] ?? "";

  // 3. Launcher shebang is exactly #!/bin/sh (portable; no env -S dependency)
  const expectedShebang = "#!/bin/sh";
  if (firstLine === expectedShebang) {
    pass(`launcher shebang is "${expectedShebang}"`);
  } else {
    fail(
      `launcher shebang mismatch — expected "${expectedShebang}", got "${firstLine}"`,
    );
  }

  // 4. Owner-execute bit (mode & 0o100)
  const mode = statSync(DIST_LAUNCHER).mode;
  if (mode & 0o100) {
    pass(`dist/bin/aws-axi is executable (mode 0${(mode & 0o777).toString(8)})`);
  } else {
    fail(
      `dist/bin/aws-axi is not executable (mode 0${(mode & 0o777).toString(8)})`,
    );
  }

  // 5. Launcher passes --no-env-file to Bun — load-bearing; prevents cwd .env
  //    from silently retargeting real-AWS calls (see issue #32 / ADR-0001).
  if (contents.includes("--no-env-file")) {
    pass(`launcher contains --no-env-file`);
  } else {
    fail(
      `launcher is missing --no-env-file — cwd .env files would silently leak into aws calls`,
    );
  }
} else {
  fail(`dist/bin/aws-axi (launcher) does not exist — run \`bun run build\` first`);
}

// 6. Launcher --version prints the package version
if (existsSync(DIST_LAUNCHER)) {
  const result = spawnSync(DIST_LAUNCHER, ["--version"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  const stdout = (result.stdout ?? "").trim();
  if (result.error) {
    fail(`--version spawn failed: ${result.error.message}`);
  } else if (result.status !== 0) {
    fail(
      `--version exited ${result.status ?? "null"}: ${(result.stderr ?? "").trim()}`,
    );
  } else if (!stdout.includes(expectedVersion)) {
    fail(
      `--version output "${stdout}" does not contain expected version "${expectedVersion}"`,
    );
  } else {
    pass(`--version prints "${stdout}" (contains ${expectedVersion})`);
  }
}

if (allPassed) {
  console.log("\ndist verified — ready to publish.");
  process.exit(0);
} else {
  console.error("\ndist verification FAILED.");
  process.exit(1);
}
