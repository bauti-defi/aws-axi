/**
 * E2E proof: the real `aws` binary with a broken SSO config emits exit 253
 * after the AUTH_EXPIRED fix in src/errors.ts.
 *
 * Requirements:
 *   - Drives the real installed `aws` CLI (not a stub)
 *   - Uses an isolated AWS_CONFIG_FILE + HOME — never reads or mutates
 *     the developer's real ~/.aws (ADR-0003)
 *   - Asserts exit 253 (AUTH_EXPIRED) end-to-end
 *
 * If `aws` is not installed, the test FAILS loudly rather than silently passing.
 * (A silent skip would hide a broken environment. A loud failure is preferable.)
 *
 * aws version used during capture: aws-cli/2.33.13 Python/3.13.11 Darwin/25.2.0
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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { parseAwsError, awsExitCode } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Detect real aws binary — LOUD FAILURE if absent (never silent skip)
// ---------------------------------------------------------------------------

let AWS_BIN: string | null = null;
try {
  AWS_BIN = execFileSync("which", ["aws"], { encoding: "utf8" }).trim() || null;
} catch {
  // `which` failed — aws is not installed
}

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
          // Clear any ambient credential env vars that could bypass SSO
          AWS_ACCESS_KEY_ID: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
          AWS_SESSION_TOKEN: undefined,
          AWS_PROFILE: undefined,
          AWS_DEFAULT_PROFILE: undefined,
        } as Record<string, string | undefined>,
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
    // new sso-session format (aws-cli >= 2.x recommended shape)
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
    // The aws CLI stores SSO tokens in ~/.aws/sso/cache/<sha1-of-session-name>.json
    // for the new sso-session format.
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
    expect(result.stderr.trim()).not.toBe("");

    // ── Run through parseAwsError — must map to AUTH_EXPIRED ──────────────
    const parsed = parseAwsError(result.stderr.trim(), result.exitCode);

    expect(parsed.code).toBe("AUTH_EXPIRED");

    // ── The exit code aws-axi emits must be 253 (the promised exit code) ──
    expect(awsExitCode(parsed.code)).toBe(253);

    // ── Suggestions must include sso login --profile ───────────────────────
    const allSuggestions = parsed.suggestions.join(" ");
    expect(allSuggestions).toContain("sso login");
    expect(allSuggestions).toContain("--profile");
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

    // ── Isolated legacy SSO config (no [sso-session] stanza) ─────────────
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

    // ── Plant an expired legacy SSO token ────────────────────────────────
    // Legacy format: keyed on sha1 of the start_url
    const cacheDir = join(home, ".aws", "sso", "cache");
    mkdirSync(cacheDir, { recursive: true });

    const cacheFile = join(cacheDir, `${sha1Hex(ssoStartUrl)}.json`);
    writeFileSync(
      cacheFile,
      JSON.stringify({
        startUrl: ssoStartUrl,
        region: "us-east-1",
        accessToken: "fake-expired-legacy-token",
        expiresAt: "2020-01-01T00:00:00UTC", // far in the past
      }),
      "utf-8",
    );

    // ── Spawn real aws ────────────────────────────────────────────────────
    const result = await spawnRealAws({
      profile: "legacy-e2e-profile",
      configFile,
      home,
    });

    expect(result.exitCode).toBe(255);
    expect(result.stderr.trim()).not.toBe("");

    const parsed = parseAwsError(result.stderr.trim(), result.exitCode);

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

    const parsed = parseAwsError(result.stderr.trim(), result.exitCode);
    expect(parsed.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(parsed.code)).toBe(253);
  });
});
