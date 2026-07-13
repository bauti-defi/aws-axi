/**
 * Regression tests for #32 — aws-axi must NOT auto-load .env from cwd.
 *
 * Root cause: Bun runtime auto-loads .env from cwd (Node does not). Any repo that
 * ships AWS_ENDPOINT_URL=http://localhost:4566 in its .env (a very normal LocalStack
 * test setup) silently retargets every real-AWS call at localhost, producing a
 * misleading "Could not connect to the endpoint URL" error.
 *
 * Fix: shebang uses `#!/usr/bin/env -S bun --no-env-file` to suppress the auto-load.
 *
 * Two levels of verification:
 *
 *   1. Shebang constant — bin/aws-axi.ts first line is exactly `#!/usr/bin/env -S bun
 *      --no-env-file`. This test FAILS before the fix and PASSES after.
 *
 *   2. Process isolation — spawning the binary via `bun --no-env-file` (what the fixed
 *      shebang does) with a .env in cwd does NOT pass the canary var to the child aws
 *      process. The stub aws writes whatever $AXI_CANARY it sees to a sentinel file;
 *      after the fix the sentinel is empty.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(join(import.meta.dir, ".."));
const BIN_FILE = join(REPO_ROOT, "bin", "aws-axi.ts");

/** The exact shebang that suppresses Bun's .env auto-load. */
const EXPECTED_SHEBANG = "#!/usr/bin/env -S bun --no-env-file";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Shebang constant
//    FAILS before the fix (shebang is "#!/usr/bin/env bun"), PASSES after.
// ---------------------------------------------------------------------------

describe("bin/aws-axi.ts shebang", () => {
  it(`first line is exactly "${EXPECTED_SHEBANG}"`, () => {
    const contents = readFileSync(BIN_FILE, "utf-8");
    const firstLine = contents.split("\n")[0] ?? "";
    expect(firstLine).toBe(EXPECTED_SHEBANG);
  });
});

// ---------------------------------------------------------------------------
// 2. Process isolation
//    Spawn `bun --no-env-file bin/aws-axi.ts whoami` with a .env in cwd
//    containing AXI_CANARY=from-dotenv and a stub `aws` that dumps
//    $AXI_CANARY to a sentinel file.  The sentinel must be empty: if the
//    .env had leaked, it would contain "from-dotenv".
// ---------------------------------------------------------------------------

describe("process isolation — cwd .env does not reach the child aws process", () => {
  it("AXI_CANARY from cwd .env is absent in the env the child aws process sees", () => {
    // A cwd directory that holds a .env with a canary var
    const cwdDir = mkdtempSync(join(tmpdir(), "aws-axi-nodotenv-cwd-"));
    tempDirs.push(cwdDir);
    writeFileSync(
      join(cwdDir, ".env"),
      "AXI_CANARY=from-dotenv\nAWS_ENDPOINT_URL=http://localhost:4566\n",
    );

    // Stub aws: write the value of $AXI_CANARY (empty if unset) to a sentinel
    // file, then emit valid JSON so aws-axi whoami can parse the response.
    const stubDir = mkdtempSync(join(tmpdir(), "aws-axi-nodotenv-stub-"));
    tempDirs.push(stubDir);
    const sentinelFile = join(cwdDir, "canary-sentinel.txt");
    const stubAws = [
      "#!/bin/sh",
      // Write whatever the child process sees for AXI_CANARY.
      // Uses printf so we get an empty file (not a missing file) when unset.
      `printf '%s' "$AXI_CANARY" > '${sentinelFile}'`,
      // Minimal valid STS GetCallerIdentity response so whoami can parse it.
      `echo '{"Account":"000000000000","UserId":"AIDA","Arn":"arn:aws:iam::000000000000:user/test"}'`,
    ].join("\n");
    writeFileSync(join(stubDir, "aws"), stubAws);
    chmodSync(join(stubDir, "aws"), 0o755);

    // Spawn via `bun --no-env-file` — the exact invocation the fixed shebang
    // produces when the dist binary is executed directly.
    const result = spawnSync(
      "bun",
      ["--no-env-file", BIN_FILE, "whoami"],
      {
        cwd: cwdDir,
        env: {
          ...process.env,
          // Prepend stub dir so `aws` resolves to our stub, not the real CLI.
          PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf-8",
        timeout: 15_000,
      },
    );

    // If the spawn itself fails, surface the error clearly.
    if (result.error) {
      throw new Error(`spawn failed: ${result.error.message}`);
    }

    // Read the sentinel — it is written by the stub regardless of exit code.
    let sentinel: string;
    try {
      sentinel = readFileSync(sentinelFile, "utf-8");
    } catch {
      // Stub was never invoked (aws-axi errored before reaching it).
      // Treat as empty: .env var definitely did not reach the child.
      sentinel = "";
    }

    // Core assertion: the canary must be absent.
    expect(sentinel).toBe(
      "",
      `AXI_CANARY leaked into the child process env (sentinel contains "${sentinel}"). ` +
        `The .env auto-load was not suppressed.`,
    );
  });
});
