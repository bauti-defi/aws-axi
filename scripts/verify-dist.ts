#!/usr/bin/env bun
/**
 * Verify that the built dist/ output is complete and runnable.
 *
 * Checks:
 *   1. dist/bin/aws-axi.js exists
 *   2. Its first line is exactly "#!/usr/bin/env bun"
 *   3. It has the owner-execute bit set
 *   4. Running it with --version prints the version from package.json
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
const DIST_BIN = join(ROOT, "dist", "bin", "aws-axi.js");
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

// 1. File exists
if (existsSync(DIST_BIN)) {
  pass(`dist/bin/aws-axi.js exists`);
} else {
  fail(`dist/bin/aws-axi.js does not exist — run \`bun run build\` first`);
}

if (existsSync(DIST_BIN)) {
  const contents = readFileSync(DIST_BIN, "utf-8");
  const firstLine = contents.split("\n")[0] ?? "";

  // 2. Shebang is exactly #!/usr/bin/env bun
  const expectedShebang = "#!/usr/bin/env bun";
  if (firstLine === expectedShebang) {
    pass(`shebang is "${expectedShebang}"`);
  } else {
    fail(
      `shebang mismatch — expected "${expectedShebang}", got "${firstLine}"`,
    );
  }

  // 3. Owner-execute bit (mode & 0o100)
  const mode = statSync(DIST_BIN).mode;
  if (mode & 0o100) {
    pass(`dist/bin/aws-axi.js is executable (mode 0${(mode & 0o777).toString(8)})`);
  } else {
    fail(
      `dist/bin/aws-axi.js is not executable (mode 0${(mode & 0o777).toString(8)})`,
    );
  }

  // 4. --version prints the package version
  const result = spawnSync("bun", ["run", DIST_BIN, "--version"], {
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
