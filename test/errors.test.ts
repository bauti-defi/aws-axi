import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAwsError,
  mapAwsError,
  awsExitCode,
  awsNotInstalledError,
} from "../src/errors.js";
import { AxiError } from "axi-sdk-js";

// Real botocore stderr strings, pinned from aws-cli 2.33.13 output.

// ---------------------------------------------------------------------------
// Fixture loader — reads verbatim stderr captured from the real aws binary.
// See test/fixtures/sso-errors/README.md for capture methodology.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sso-errors",
);

/** Read a SSO error fixture file (verbatim stderr from the real aws binary). */
function ssoFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8").trim();
}

describe("parseAwsError — credential errors", () => {
  it("maps 'Unable to locate credentials' to NO_CREDENTIALS", () => {
    const result = parseAwsError(
      "Unable to locate credentials",
      255,
    );
    expect(result.code).toBe("NO_CREDENTIALS");
    expect(result.suggestions.some((s) => s.includes("sso login"))).toBe(true);
  });

  it("maps ExpiredTokenException to AUTH_EXPIRED", () => {
    const result = parseAwsError(
      "An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: The security token included in the request is expired",
      255,
    );
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(result.botoCode).toBe("ExpiredTokenException");
    expect(result.operation).toBe("GetCallerIdentity");
    expect(result.suggestions.some((s) => s.includes("sso login"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSO auth-expired patterns — real stderr from aws-cli/2.33.13
// (fixture-backed: NOT hand-written strings asserted against hand-written
// regexes — each fixture is verbatim output from the real aws binary)
// ---------------------------------------------------------------------------

describe("parseAwsError — SSO auth-expired (new sso-session format)", () => {
  /**
   * State: [sso-session] configured, no token in ~/.aws/sso/cache/ at all.
   * Captured: aws-cli/2.33.13, exit 255
   * Expected: AUTH_EXPIRED (the fix is to run aws sso login)
   */
  it("maps 'Error loading SSO Token: ... does not exist' (new format) to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("new-sso-session-no-cache.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(result.botoCode).toBeUndefined();
    expect(result.suggestions.some((s) => s.includes("sso login") && s.includes("--profile"))).toBe(
      true,
    );
    expect(awsExitCode(result.code)).toBe(253);
  });

  /**
   * State: [sso-session] configured, cached token expiresAt in the past.
   * Captured: aws-cli/2.33.13, exit 255
   * Expected: AUTH_EXPIRED
   */
  it("maps 'Error when retrieving token from sso: Token has expired' to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("new-sso-session-expired.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(result.botoCode).toBeUndefined();
    expect(result.suggestions.some((s) => s.includes("sso login") && s.includes("--profile"))).toBe(
      true,
    );
    expect(awsExitCode(result.code)).toBe(253);
  });

  /**
   * State: [sso-session] configured, cached token is malformed / missing fields.
   * Captured: aws-cli/2.33.13, exit 255
   * Expected: AUTH_EXPIRED (the fix is to run aws sso login)
   */
  it("maps 'Error loading SSO Token: ... is invalid' (malformed token) to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("new-sso-session-invalid-token.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(result.botoCode).toBeUndefined();
    expect(result.suggestions.some((s) => s.includes("sso login") && s.includes("--profile"))).toBe(
      true,
    );
    expect(awsExitCode(result.code)).toBe(253);
  });
});

describe("parseAwsError — SSO auth-expired (legacy sso format)", () => {
  /**
   * State: legacy [profile] with sso_* keys (no [sso-session] stanza), no cached token.
   * Captured: aws-cli/2.33.13, exit 255
   * Expected: AUTH_EXPIRED
   */
  it("maps 'Error loading SSO Token: ... does not exist' (legacy format) to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("legacy-sso-no-cache.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(result.botoCode).toBeUndefined();
    expect(result.suggestions.some((s) => s.includes("sso login") && s.includes("--profile"))).toBe(
      true,
    );
    expect(awsExitCode(result.code)).toBe(253);
  });

  /**
   * State: legacy [profile] with sso_* keys, cached token is expired.
   * Captured: aws-cli/2.33.13, exit 255
   * Expected: AUTH_EXPIRED
   */
  it("maps 'The SSO session associated with this profile has expired' to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("legacy-sso-expired.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(result.botoCode).toBeUndefined();
    expect(result.suggestions.some((s) => s.includes("sso login") && s.includes("--profile"))).toBe(
      true,
    );
    expect(awsExitCode(result.code)).toBe(253);
  });
});

// ---------------------------------------------------------------------------
// Precedence: SSO messages must not be shadowed by NO_CREDS_PATTERNS
//
// NO_CREDS_PATTERNS are checked before SSO patterns in parseAwsError.
// This test proves the captured SSO messages do NOT match those patterns,
// i.e., there is no shadowing in either ordering.
// ---------------------------------------------------------------------------

describe("parseAwsError — SSO patterns do not shadow NO_CREDS_PATTERNS", () => {
  it("SSO 'does not exist' message is not swallowed by NO_CREDENTIALS", () => {
    // If this returned NO_CREDENTIALS, adding `--profile` wouldn't help.
    // AUTH_EXPIRED is the correct code: the user must run aws sso login.
    const result = parseAwsError(ssoFixture("new-sso-session-no-cache.txt"), 255);
    expect(result.code).not.toBe("NO_CREDENTIALS");
    expect(result.code).toBe("AUTH_EXPIRED");
  });

  it("SSO 'expired' message is not swallowed by NO_CREDENTIALS", () => {
    const result = parseAwsError(ssoFixture("legacy-sso-expired.txt"), 255);
    expect(result.code).not.toBe("NO_CREDENTIALS");
    expect(result.code).toBe("AUTH_EXPIRED");
  });

  it("NO_CREDENTIALS patterns still work for non-SSO messages (not swallowed by SSO check)", () => {
    // Verify SSO addition does NOT break the existing NO_CREDENTIALS detection.
    const result = parseAwsError("Unable to locate credentials", 255);
    expect(result.code).toBe("NO_CREDENTIALS");
  });
});

// ---------------------------------------------------------------------------
// NO_PROFILE_SELECTED interaction
//
// enrichNoCredsError (in aws.ts) only upgrades NO_CREDENTIALS → NO_PROFILE_SELECTED.
// AUTH_EXPIRED is never touched by that upgrade path.
// These tests confirm the wiring at the parseAwsError level — the error code
// returned here is what enrichNoCredsError receives.
// ---------------------------------------------------------------------------

describe("parseAwsError — AUTH_EXPIRED is not upgrade-able to NO_PROFILE_SELECTED", () => {
  it("SSO expired error stays AUTH_EXPIRED regardless of profile selection state", () => {
    // The upgrade path in aws.ts's enrichNoCredsError checks:
    //   if (parsed.code !== "NO_CREDENTIALS" || context?.profile) return parsed;
    // So AUTH_EXPIRED is returned unchanged — no profile selection logic applies.
    const result = parseAwsError(ssoFixture("new-sso-session-expired.txt"), 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    // Specifically NOT NO_PROFILE_SELECTED (which would suggest --profile rather than sso login)
    expect(result.code).not.toBe("NO_PROFILE_SELECTED");
    expect(result.code).not.toBe("NO_CREDENTIALS");
  });
});

// ---------------------------------------------------------------------------
// AUTH_EXPIRED suggestion text — must include --profile <name>
// (matches README.md and skills/aws-axi/SKILL.md)
// ---------------------------------------------------------------------------

describe("AUTH_EXPIRED suggestions include --profile <name>", () => {
  it("botocore ExpiredTokenException suggestion mentions --profile", () => {
    const result = parseAwsError(
      "An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: expired",
      255,
    );
    expect(result.code).toBe("AUTH_EXPIRED");
    const allSuggestions = result.suggestions.join(" ");
    expect(allSuggestions).toContain("--profile");
    expect(allSuggestions).toContain("sso login");
  });

  it("SSO expired suggestion mentions --profile", () => {
    const result = parseAwsError(ssoFixture("new-sso-session-expired.txt"), 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    const allSuggestions = result.suggestions.join(" ");
    expect(allSuggestions).toContain("--profile");
    expect(allSuggestions).toContain("sso login");
  });
});

describe("parseAwsError — DryRun success signal", () => {
  it("maps DryRunOperation to DRY_RUN_SUCCESS", () => {
    const result = parseAwsError(
      "An error occurred (DryRunOperation) when calling the RunInstances operation: Request would have succeeded, but DryRun flag is set.",
      255,
    );
    expect(result.code).toBe("DRY_RUN_SUCCESS");
    expect(result.botoCode).toBe("DryRunOperation");
    expect(result.operation).toBe("RunInstances");
  });
});

describe("parseAwsError — service client errors", () => {
  it("maps AccessDenied to SERVICE_CLIENT_ERROR", () => {
    const result = parseAwsError(
      "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: User: arn:aws:iam::123456789012:user/test is not authorized to perform: sts:GetCallerIdentity",
      255,
    );
    expect(result.code).toBe("SERVICE_CLIENT_ERROR");
    expect(result.botoCode).toBe("AccessDenied");
    expect(result.operation).toBe("GetCallerIdentity");
    expect(result.message).toContain("AccessDenied");
  });

  it("maps NoSuchBucket to SERVICE_CLIENT_ERROR", () => {
    const result = parseAwsError(
      "An error occurred (NoSuchBucket) when calling the ListObjects operation: The specified bucket does not exist",
      255,
    );
    expect(result.code).toBe("SERVICE_CLIENT_ERROR");
    expect(result.botoCode).toBe("NoSuchBucket");
  });
});

describe("parseAwsError — aws not installed", () => {
  it("maps ENOENT sentinel to AWS_NOT_INSTALLED", () => {
    const result = parseAwsError("ENOENT", 127);
    expect(result.code).toBe("AWS_NOT_INSTALLED");
    expect(result.message).toContain("aws CLI");
  });
});

describe("parseAwsError — unknown/general errors", () => {
  it("maps unrecognized stderr to UNKNOWN", () => {
    const result = parseAwsError("some random error from aws", 255);
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe("some random error from aws");
  });

  it("uses first line of multi-line stderr", () => {
    const result = parseAwsError("first line\nsecond line\nthird line", 255);
    expect(result.message).toBe("first line");
  });

  it("includes code in message when stderr is empty", () => {
    const result = parseAwsError("", 255);
    expect(result.message).toContain("255");
  });
});

describe("awsExitCode", () => {
  it("returns 252 for USAGE_ERROR", () => {
    expect(awsExitCode("USAGE_ERROR")).toBe(252);
  });

  it("returns 253 for NO_CREDENTIALS", () => {
    expect(awsExitCode("NO_CREDENTIALS")).toBe(253);
  });

  it("returns 253 for AUTH_EXPIRED", () => {
    expect(awsExitCode("AUTH_EXPIRED")).toBe(253);
  });

  it("returns 254 for SERVICE_CLIENT_ERROR", () => {
    expect(awsExitCode("SERVICE_CLIENT_ERROR")).toBe(254);
  });

  it("returns 0 for DRY_RUN_SUCCESS (treat as success)", () => {
    expect(awsExitCode("DRY_RUN_SUCCESS")).toBe(0);
  });

  it("returns 127 for AWS_NOT_INSTALLED", () => {
    expect(awsExitCode("AWS_NOT_INSTALLED")).toBe(127);
  });

  it("returns 255 for UNKNOWN", () => {
    expect(awsExitCode("UNKNOWN")).toBe(255);
  });
});

describe("mapAwsError", () => {
  it("returns an AxiError with correct code and message", () => {
    const err = mapAwsError(
      "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: forbidden",
      255,
    );
    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe("SERVICE_CLIENT_ERROR");
    expect(err.message).toContain("AccessDenied");
  });
});

describe("awsNotInstalledError", () => {
  it("returns AxiError with AWS_NOT_INSTALLED code", () => {
    const err = awsNotInstalledError();
    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe("AWS_NOT_INSTALLED");
    expect(err.message).toContain("aws CLI");
  });
});
