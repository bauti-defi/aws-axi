/**
 * E2E proof: the real `aws` binary with no region configured emits exit 252
 * (NO_REGION) after the fix in src/errors.ts.
 *
 * Requirements:
 *   - Drives the real installed `aws` CLI (not a stub)
 *   - Uses an isolated AWS_CONFIG_FILE + HOME — never reads or mutates
 *     the developer's real ~/.aws (ADR-0003)
 *   - `env -i`-style environment (PATH-only) so no AWS_DEFAULT_REGION,
 *     AWS_REGION, or other region hints can leak in from the shell
 *   - Asserts exit 252 (NO_REGION) on the *built binary* (./dist/bin/aws-axi),
 *     not just on the return value of awsExitCode(). A bug where the binary
 *     doesn't trim but tests do would be invisible to unit-only assertions.
 *   - No .trim() on stderr before passing to parseAwsError — production doesn't.
 *
 * If `aws` is not installed, the test FAILS loudly rather than silently passing.
 *
 * Adversarial invariant tested here (end-to-end, not just unit):
 *   - NO_REGION must exit 252, not 255 (UNKNOWN) and not 253 (AUTH_EXPIRED)
 *   - The raw aws stderr (no trim) must classify as NO_REGION through parseAwsError
 *
 * aws version used during development:
 *   aws-cli/2.33.13 Python/3.13.11 Darwin/25.2.0
 * CI runner: >= 2.34.0 (adds "aws: [ERROR]: " prefix — handled by normalization).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseAwsError, awsExitCode } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Detect real aws binary — LOUD FAILURE if absent
// ---------------------------------------------------------------------------

let AWS_BIN: string | null = null;
let AWS_VERSION = "unknown";
try {
  AWS_BIN = execFileSync("which", ["aws"], { encoding: "utf8" }).trim() || null;
  if (AWS_BIN) {
    try {
      AWS_VERSION = execFileSync("aws", ["--version"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      // --version writes to stderr on some platforms
      AWS_VERSION = "unknown";
    }
  }
} catch {
  // aws is not installed
}

// ---------------------------------------------------------------------------
// Locate the built dist binary for exit-code assertions
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_BIN = join(REPO_ROOT, "dist", "bin", "aws-axi");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Spawn the real `aws` binary with a completely isolated environment:
 * only PATH is inherited; no AWS_*, HOME, or region env vars are present.
 * Returns stdout, stderr (RAW — no trimming), and exit code.
 *
 * This matches the "env -i" isolation used to capture the fixture files.
 */
async function spawnRealAws(opts: {
  readonly configFile: string;
  readonly isolatedHome: string;
}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    execFile(
      "aws",
      ["lambda", "invoke", "--function-name", "f", "/dev/null", "--output", "json"],
      {
        encoding: "utf8",
        env: {
          // Only PATH — no AWS region vars, no HOME pointing to real ~/.aws
          PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: opts.isolatedHome,
          AWS_CONFIG_FILE: opts.configFile,
          AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/credentials",
          // Explicitly absent: AWS_DEFAULT_REGION, AWS_REGION, AWS_PROFILE, etc.
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error
          ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
          : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof code === "number" ? code : 1,
        });
      },
    );
  });
}

/**
 * Spawn the BUILT aws-axi binary with isolated env and no region configured.
 * The lambda invoke operation requires a region — this exercises the
 * NO_REGION path end-to-end through the built binary.
 */
async function spawnBuiltAxi(opts: {
  readonly configFile: string;
  readonly isolatedHome: string;
}): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      DIST_BIN,
      ["lambda", "invoke", "--function-name", "f", "--payload", "{}"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: opts.isolatedHome,
          AWS_CONFIG_FILE: opts.configFile,
          AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/credentials",
        },
        maxBuffer: 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        const code = error
          ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
          : 0;
        resolve({
          exitCode: typeof code === "number" ? code : 1,
          stderr: stderr ?? "",
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Isolated workspace lifecycle
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-nr-e2e-"));
  cleanupDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

describe("E2E — real aws binary with no region emits NO_REGION / exit 252", () => {
  it("REAL AWS BINARY: region-less invocation → NO_REGION (exit 252)", async () => {
    if (!AWS_BIN) {
      throw new Error(
        "REQUIRES aws CLI: aws binary not found in PATH.\n" +
          "Install it (https://aws.amazon.com/cli/) and re-run.\n" +
          "This test drives the real binary to prove exit 252 end-to-end.",
      );
    }

    const tmpDir = makeTmpDir();
    const isolatedHome = join(tmpDir, "home");
    mkdirSync(isolatedHome, { recursive: true });

    // Empty config — no profile, no region
    const configFile = join(tmpDir, "config");
    writeFileSync(configFile, "", "utf-8");

    // ── Spawn the REAL aws binary with isolated env ───────────────────────
    const result = await spawnRealAws({ configFile, isolatedHome });

    // The real aws binary should exit non-zero with the region message
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.trim()).not.toBe("");

    // ── Feed RAW stderr (no .trim()) to parseAwsError, matching production ─
    const parsed = parseAwsError(result.stderr, result.exitCode);

    if (parsed.code !== "NO_REGION") {
      throw new Error(
        `Expected NO_REGION but got ${parsed.code}.\n` +
          `aws version: ${AWS_VERSION}\n` +
          `Raw stderr bytes: ${JSON.stringify(result.stderr)}\n` +
          `This may indicate a new aws-cli stderr format. ` +
          `Recapture fixtures and update NO_REGION_PATTERNS in src/errors.ts.`,
      );
    }

    expect(parsed.code).toBe("NO_REGION");
    expect(awsExitCode(parsed.code)).toBe(252);

    // ── Proof via the BUILT BINARY: aws-axi must exit 252, not 255 ────────
    // This catches the class of bug where tests trim but production doesn't.
    const axiResult = await spawnBuiltAxi({ configFile, isolatedHome });

    if (axiResult.exitCode !== 252) {
      throw new Error(
        `Built binary (${DIST_BIN}) exited ${axiResult.exitCode} (expected 252).\n` +
          `aws version: ${AWS_VERSION}\n` +
          `aws-axi stderr: ${JSON.stringify(axiResult.stderr)}\n` +
          `This means the binary is still returning UNKNOWN/255 despite unit tests passing. ` +
          `Check whether real aws stderr is trimmed before reaching parseAwsError in src/aws.ts.`,
      );
    }

    expect(axiResult.exitCode).toBe(252);
  });

  it("REAL AWS BINARY: region-less failure must NOT classify as AUTH_EXPIRED (direction invariant)", async () => {
    if (!AWS_BIN) {
      throw new Error(
        "REQUIRES aws CLI: aws binary not found in PATH.\n" +
          "Install it and re-run.",
      );
    }

    const tmpDir = makeTmpDir();
    const isolatedHome = join(tmpDir, "home");
    mkdirSync(isolatedHome, { recursive: true });
    const configFile = join(tmpDir, "config");
    writeFileSync(configFile, "", "utf-8");

    const result = await spawnRealAws({ configFile, isolatedHome });

    const parsed = parseAwsError(result.stderr, result.exitCode);

    // Adversarial direction: region message must never reach AUTH_EXPIRED
    expect(parsed.code).not.toBe("AUTH_EXPIRED");
    expect(parsed.code).not.toBe("UNKNOWN");
    expect(parsed.code).toBe("NO_REGION");
  });
});
