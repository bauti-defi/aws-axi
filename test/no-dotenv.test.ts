/**
 * Regression tests for #32 — the installed aws-axi CLI must NOT auto-load
 * .env from the user's cwd.
 *
 * Root cause: Bun runtime auto-loads .env from cwd on startup (Node does not).
 * Any repo shipping AWS_ENDPOINT_URL=http://localhost:4566 in its .env (a very
 * normal LocalStack test setup) silently retargets every aws-axi call at
 * localhost, producing a misleading "Could not connect to the endpoint URL"
 * error with no indication that a dotfile is responsible.
 *
 * Fix: a POSIX sh launcher (dist/bin/aws-axi) execs Bun with --no-env-file,
 * preventing the auto-load.  The launcher also resolves symlinks so npm/bun
 * global installs (which symlink the entry into a different directory) work
 * correctly.  Works on macOS, glibc Linux, and Alpine/BusyBox (no env -S).
 *
 * Three levels of verification:
 *
 *   1. Launcher contract — dist/bin/aws-axi exists, is executable, has #!/bin/sh
 *      as its first line, and contains --no-env-file.  These assertions FAIL if
 *      the launcher is absent or has the wrong content.
 *
 *   2. Process isolation (end-to-end) — the real built launcher is executed
 *      directly (NOT via `bun --no-env-file`; the launcher handles that), with
 *      cwd set to a temp dir containing a poisoned .env.  A stub aws writes
 *      whatever $AXI_CANARY it sees to a sentinel file.  After the fix the
 *      sentinel is empty.  If the stub never runs, the test FAILS loudly.
 *
 * PREREQUISITE: `bun run build` must have been run before `bun test`.
 * The CI workflow enforces this by running the build step before the test step.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(join(import.meta.dir, ".."));
const LAUNCHER = join(REPO_ROOT, "dist", "bin", "aws-axi");

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
// 1. Launcher contract assertions
//    FAIL if the launcher is missing, has the wrong shebang, is not executable,
//    or does not contain --no-env-file.
// ---------------------------------------------------------------------------

describe("dist/bin/aws-axi launcher contract", () => {
  it("launcher exists (requires `bun run build` to have run first)", () => {
    expect(existsSync(LAUNCHER)).toBe(
      true,
      "dist/bin/aws-axi does not exist — run `bun run build` first",
    );
  });

  it('first line is exactly "#!/bin/sh"', () => {
    const contents = readFileSync(LAUNCHER, "utf-8");
    const firstLine = contents.split("\n")[0] ?? "";
    expect(firstLine).toBe("#!/bin/sh");
  });

  it("has the owner-execute bit set", () => {
    const mode = statSync(LAUNCHER).mode;
    expect(!!(mode & 0o100)).toBe(
      true,
      `dist/bin/aws-axi is not executable (mode 0${(mode & 0o777).toString(8)})`,
    );
  });

  it("contains --no-env-file (the .env isolation guard)", () => {
    const contents = readFileSync(LAUNCHER, "utf-8");
    expect(contents).toContain(
      "--no-env-file",
      "launcher is missing --no-env-file — cwd .env files would silently leak into aws calls",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Process isolation (end-to-end)
//    Execute the REAL built launcher as an executable — NOT via `bun --no-env-file`
//    in the test's own argv.  The launcher's own #!/bin/sh + exec bun --no-env-file
//    is what gets tested.
//
//    Setup:
//      - cwdDir: a temp dir containing a .env with AXI_CANARY=from-dotenv and
//        AWS_ENDPOINT_URL=http://localhost:4566 (the footgun from issue #32).
//      - stubDir: a stub `aws` script that writes $AXI_CANARY to a sentinel file,
//        then emits minimal valid STS JSON so whoami can parse the response.
//      - We prepend stubDir to PATH so the launcher's Bun process finds our stub.
//
//    Assertion:
//      - If the sentinel file is not written, the stub never ran → FAIL.
//      - If the sentinel contains "from-dotenv", the .env leaked → FAIL.
//      - Sentinel must be empty ("") → the .env was suppressed.
// ---------------------------------------------------------------------------

describe("process isolation — cwd .env must not reach the child aws process", () => {
  it("AXI_CANARY from cwd .env is absent in the env the child aws process sees", () => {
    // Require the launcher to exist before running the isolation test.
    if (!existsSync(LAUNCHER)) {
      throw new Error(
        "dist/bin/aws-axi does not exist — run `bun run build` before `bun test`",
      );
    }

    // A cwd directory with a poisoned .env.
    const cwdDir = mkdtempSync(join(tmpdir(), "aws-axi-nodotenv-cwd-"));
    tempDirs.push(cwdDir);
    writeFileSync(
      join(cwdDir, ".env"),
      "AXI_CANARY=from-dotenv\nAWS_ENDPOINT_URL=http://localhost:4566\n",
    );

    // Stub aws: write $AXI_CANARY to the sentinel file (empty string if unset),
    // then emit minimal valid STS GetCallerIdentity JSON for whoami to parse.
    const stubDir = mkdtempSync(join(tmpdir(), "aws-axi-nodotenv-stub-"));
    tempDirs.push(stubDir);
    const sentinelFile = join(cwdDir, "canary-sentinel.txt");
    const stubScript = [
      "#!/bin/sh",
      // printf with no format args writes the value of AXI_CANARY (empty if unset).
      `printf '%s' "$AXI_CANARY" > '${sentinelFile}'`,
      // Minimal valid response so aws-axi whoami can parse and exit cleanly.
      `echo '{"Account":"000000000000","UserId":"AIDA","Arn":"arn:aws:iam::000000000000:user/test"}'`,
    ].join("\n");
    writeFileSync(join(stubDir, "aws"), stubScript);
    chmodSync(join(stubDir, "aws"), 0o755);

    // Execute the REAL launcher as an executable — the kernel reads #!/bin/sh
    // and the script execs `bun --no-env-file dist/bin/aws-axi.js whoami`.
    // We do NOT manually pass --no-env-file here; the launcher handles it.
    const result = spawnSync(LAUNCHER, ["whoami"], {
      cwd: cwdDir,
      env: {
        ...process.env,
        // Prepend stub dir so `aws` in PATH resolves to our stub, not the system CLI.
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf-8",
      timeout: 15_000,
    });

    // Spawn must not fail at the OS level (ENOENT, EACCES, etc.).
    if (result.error) {
      throw new Error(`launcher spawn failed: ${result.error.message}`);
    }

    // The sentinel MUST exist — if it doesn't, the stub never ran, meaning
    // aws-axi exited before ever invoking `aws`.  That is a test bug or a
    // change to the whoami flow, not a success.
    const sentinelExists = existsSync(sentinelFile);
    expect(sentinelExists).toBe(
      true,
      `Sentinel file was not written — the stub aws was never invoked.\n` +
        `  launcher exit code: ${result.status ?? "null"}\n` +
        `  launcher stdout: ${result.stdout.trim()}\n` +
        `  launcher stderr: ${result.stderr.trim()}`,
    );

    const sentinel = readFileSync(sentinelFile, "utf-8");

    // Core assertion: the canary must be absent from the child's env.
    // If it appears here, the launcher is not passing --no-env-file to Bun.
    expect(sentinel).toBe(
      "",
      `AXI_CANARY leaked into the child process env (sentinel = "${sentinel}").\n` +
        `The launcher is NOT suppressing .env auto-load — check that it passes --no-env-file to Bun.`,
    );
  });
});
