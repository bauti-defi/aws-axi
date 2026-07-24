/**
 * E2E proof: the real `aws` binary with a broken SSO config emits exit 253
 * after the AUTH_EXPIRED fix in src/errors.ts.
 *
 * Requirements:
 *   - Drives the real installed `aws` CLI (not a stub)
 *   - Uses an isolated AWS_CONFIG_FILE + HOME — never reads or mutates
 *     the developer's real ~/.aws (ADR-0003)
 *   - Asserts exit 253 (AUTH_EXPIRED) on the *built binary* (./dist/bin/aws-axi),
 *     not just on the return value of awsExitCode(). A bug where the binary
 *     doesn't trim but tests do would be invisible to unit-only assertions.
 *   - No .trim() on stderr before passing to parseAwsError — production doesn't.
 *
 * If `aws` is not installed, the test FAILS loudly rather than silently passing.
 * (A silent skip would hide a broken environment. A loud failure is preferable.)
 *
 * aws version used during capture of 2.33.x fixtures:
 *   aws-cli/2.33.13 Python/3.13.11 Darwin/25.2.0
 * CI runner version: >= 2.34.0 (adds "aws: [ERROR]: " prefix — handled by normalization).
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  execFileSync,
  execFile,
} from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { parseAwsError, awsExitCode } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Detect real aws binary — LOUD FAILURE if absent (never silent skip)
// ---------------------------------------------------------------------------

let AWS_BIN: string | null = null;
let AWS_VERSION = "unknown";
try {
  AWS_BIN = execFileSync("which", ["aws"], { encoding: "utf8" }).trim() || null;
  if (AWS_BIN) {
    AWS_VERSION = execFileSync("aws", ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }
} catch {
  try {
    // aws --version writes to stderr on some platforms
    AWS_VERSION = execFileSync("aws", ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // aws is not installed
  }
}

// ---------------------------------------------------------------------------
// Locate the built dist binary for exit-code assertions
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_BIN = join(REPO_ROOT, "dist", "bin", "aws-axi");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-1 of `s`, hex-encoded — matches the aws CLI's SSO cache filename scheme. */
function sha1Hex(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Spawn `aws sts get-caller-identity --output json --profile <profile>` using
 * the real aws binary with an isolated environment (no access to the developer's
 * real ~/.aws). Returns stdout, stderr, and exit code.
 *
 * stderr is returned RAW — no trimming. Production (src/aws.ts) does not trim,
 * so tests must not either.
 */
async function spawnRealAws(opts: {
  readonly profile: string;
  readonly configFile: string;
  readonly home: string;
}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    execFile(
      "aws",
      ["sts", "get-caller-identity", "--output", "json", "--profile", opts.profile],
      {
        encoding: "utf8",
        env: {
          // Carry the PATH so `aws` can find itself (and its Python runtime).
          PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
          // Isolated config — never reads the developer's real ~/.aws
          AWS_CONFIG_FILE: opts.configFile,
          AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/credentials",
          HOME: opts.home,
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
 * Spawn the BUILT aws-axi binary (./dist/bin/aws-axi) with an isolated env.
 * Returns the process exit code directly — this is the proof that #74 is fixed,
 * because the built binary uses the same untrimmed stderr as production.
 */
async function spawnBuiltAxi(opts: {
  readonly profile: string;
  readonly configFile: string;
  readonly home: string;
}): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      DIST_BIN,
      ["whoami", "--profile", opts.profile],
      {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
          AWS_CONFIG_FILE: opts.configFile,
          AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/credentials",
          HOME: opts.home,
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

/** Create an isolated tmp dir, register for afterEach cleanup, return path. */
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-sso-e2e-"));
  cleanupDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

describe("E2E — real aws binary with broken SSO config emits AUTH_EXPIRED / exit 253", () => {
  it("REAL AWS BINARY: new sso-session format, expired token → AUTH_EXPIRED (exit 253)", async () => {
    // LOUD FAIL if aws is not installed — never silently pass
    if (!AWS_BIN) {
      throw new Error(
        "REQUIRES aws CLI: aws binary not found in PATH.\n" +
          "Install it (https://aws.amazon.com/cli/) and re-run.\n" +
          "This test drives the real binary to prove exit 253 end-to-end.",
      );
    }

    const tmpDir = makeTmpDir();
    const configFile = join(tmpDir, "config");
    const home = join(tmpDir, "home");

    // ── Isolated SSO config ────────────────────────────────────────────────
    const ssoSessionName = "e2e-test-sso";
    const ssoStartUrl = "https://e2e-test.awsapps.com/start";
    writeFileSync(
      configFile,
      [
        `[sso-session ${ssoSessionName}]`,
        `sso_start_url = ${ssoStartUrl}`,
        `sso_region = us-east-1`,
        `sso_registration_scopes = sso:account:access`,
        ``,
        `[profile e2e-profile]`,
        `sso_session = ${ssoSessionName}`,
        `sso_account_id = 123456789012`,
        `sso_role_name = TestRole`,
        `region = us-west-2`,
      ].join("\n"),
      "utf-8",
    );

    // ── Plant an expired SSO token in the isolated HOME ──────────────────
    // aws CLI stores SSO tokens at ~/.aws/sso/cache/<sha1(sso-session-name)>.json
    const cacheDir = join(home, ".aws", "sso", "cache");
    mkdirSync(cacheDir, { recursive: true });

    const cacheFile = join(cacheDir, `${sha1Hex(ssoSessionName)}.json`);
    writeFileSync(
      cacheFile,
      JSON.stringify({
        startUrl: ssoStartUrl,
        region: "us-east-1",
        accessToken: "fake-expired-access-token-e2e-test",
        expiresAt: "2020-01-01T00:00:00UTC", // far in the past
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        registrationExpiresAt: "2020-01-01T00:00:00UTC",
      }),
      "utf-8",
    );

    // ── Spawn the REAL aws binary with isolated env ───────────────────────
    const result = await spawnRealAws({
      profile: "e2e-profile",
      configFile,
      home,
    });

    // The real aws binary returns exit 255 with the SSO expired message
    expect(result.exitCode).toBe(255);
    expect(result.stderr.trim()).not.toBe(""); // has content (trim only for this emptiness check)

    // ── Feed RAW stderr (no .trim()) to parseAwsError, matching production ─
    // This is the critical assertion: the same path src/aws.ts uses.
    const parsed = parseAwsError(result.stderr, result.exitCode);

    if (parsed.code !== "AUTH_EXPIRED") {
      throw new Error(
        `Expected AUTH_EXPIRED but got ${parsed.code}.\n` +
          `aws version: ${AWS_VERSION}\n` +
          `Raw stderr bytes: ${JSON.stringify(result.stderr)}\n` +
          `This may indicate a new aws-cli stderr format. ` +
          `Recapture fixtures and update SSO_AUTH_EXPIRED_PATTERNS in src/errors.ts.`,
      );
    }

    expect(parsed.code).toBe("AUTH_EXPIRED");

    // ── The exit code aws-axi emits must be 253 (the promised exit code) ──
    expect(awsExitCode(parsed.code)).toBe(253);

    // ── Proof via the BUILT BINARY: aws-axi must exit 253, not 255 ────────
    // This catches the class of bug where tests trim but production doesn't:
    // if parseAwsError(stderr) and parseAwsError(stderr.trim()) diverge, the
    // built binary exposes it even if unit tests were all green.
    const axiResult = await spawnBuiltAxi({
      profile: "e2e-profile",
      configFile,
      home,
    });

    if (axiResult.exitCode !== 253) {
      throw new Error(
        `Built binary (${DIST_BIN}) exited ${axiResult.exitCode} (expected 253).\n` +
          `aws version: ${AWS_VERSION}\n` +
          `aws-axi stderr: ${JSON.stringify(axiResult.stderr)}\n` +
          `This means the binary is still returning UNKNOWN/255 despite unit tests passing. ` +
          `Check whether real aws stderr is trimmed before reaching parseAwsError in src/aws.ts.`,
      );
    }

    expect(axiResult.exitCode).toBe(253);
  });

  it("REAL AWS BINARY: legacy sso format, expired token → AUTH_EXPIRED (exit 253)", async () => {
    if (!AWS_BIN) {
      throw new Error(
        "REQUIRES aws CLI: aws binary not found in PATH.\n" +
          "Install it and re-run. This test requires the real binary.",
      );
    }

    const tmpDir = makeTmpDir();
    const configFile = join(tmpDir, "config");
    const home = join(tmpDir, "home");

    const ssoStartUrl = "https://e2e-test-legacy.awsapps.com/start";
    writeFileSync(
      configFile,
      [
        `[profile legacy-e2e-profile]`,
        `sso_start_url = ${ssoStartUrl}`,
        `sso_region = us-east-1`,
        `sso_account_id = 123456789012`,
        `sso_role_name = TestRole`,
        `region = us-west-2`,
      ].join("\n"),
      "utf-8",
    );

    // Legacy format: cache key is sha1 of the start_url
    const cacheDir = join(home, ".aws", "sso", "cache");
    mkdirSync(cacheDir, { recursive: true });

    const cacheFile = join(cacheDir, `${sha1Hex(ssoStartUrl)}.json`);
    writeFileSync(
      cacheFile,
      JSON.stringify({
        startUrl: ssoStartUrl,
        region: "us-east-1",
        accessToken: "fake-expired-legacy-token",
        expiresAt: "2020-01-01T00:00:00UTC",
      }),
      "utf-8",
    );

    const result = await spawnRealAws({
      profile: "legacy-e2e-profile",
      configFile,
      home,
    });

    expect(result.exitCode).toBe(255);

    // Raw stderr — no .trim()
    const parsed = parseAwsError(result.stderr, result.exitCode);

    if (parsed.code !== "AUTH_EXPIRED") {
      throw new Error(
        `Expected AUTH_EXPIRED but got ${parsed.code}.\n` +
          `aws version: ${AWS_VERSION}\n` +
          `Raw stderr: ${JSON.stringify(result.stderr)}`,
      );
    }

    expect(parsed.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(parsed.code)).toBe(253);
  });

  it("REAL AWS BINARY: new sso-session format, NO cached token → AUTH_EXPIRED (exit 253)", async () => {
    if (!AWS_BIN) {
      throw new Error(
        "REQUIRES aws CLI: aws binary not found in PATH.\n" +
          "Install it and re-run. This test requires the real binary.",
      );
    }

    const tmpDir = makeTmpDir();
    const configFile = join(tmpDir, "config");
    const home = join(tmpDir, "home");

    // Home with empty SSO cache dir (no token files)
    mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });

    writeFileSync(
      configFile,
      [
        `[sso-session no-cache-sso]`,
        `sso_start_url = https://no-cache.awsapps.com/start`,
        `sso_region = us-east-1`,
        `sso_registration_scopes = sso:account:access`,
        ``,
        `[profile no-cache-profile]`,
        `sso_session = no-cache-sso`,
        `sso_account_id = 123456789012`,
        `sso_role_name = TestRole`,
        `region = us-west-2`,
      ].join("\n"),
      "utf-8",
    );

    const result = await spawnRealAws({
      profile: "no-cache-profile",
      configFile,
      home,
    });

    expect(result.exitCode).toBe(255);

    // Raw stderr — no .trim()
    const parsed = parseAwsError(result.stderr, result.exitCode);

    if (parsed.code !== "AUTH_EXPIRED") {
      throw new Error(
        `Expected AUTH_EXPIRED but got ${parsed.code}.\n` +
          `aws version: ${AWS_VERSION}\n` +
          `Raw stderr: ${JSON.stringify(result.stderr)}`,
      );
    }

    expect(parsed.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(parsed.code)).toBe(253);
  });
});
