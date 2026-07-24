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
//
// NO .trim() here — fixtures are byte-exact captures including the leading \n
// that the real aws binary writes before every error message. The production
// call site (src/aws.ts) does NOT trim stderr. Tests must feed parseAwsError
// the same bytes production does, or they prove nothing about the shipped path.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sso-errors",
);

/** Read a SSO error fixture file (verbatim stderr from the real aws binary). */
function ssoFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
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
//
// Fixtures are BYTE-EXACT captures: they include the leading \n that every
// aws binary version emits before the error text, and NO trailing trim.
// The normalization in parseAwsError handles the leading \n and the
// "aws: [ERROR]: " prefix added in aws-cli >= 2.34.0.
// ---------------------------------------------------------------------------

describe("parseAwsError — SSO auth-expired (new sso-session format, aws-cli 2.33.x)", () => {
  /**
   * State: [sso-session] configured, no token in ~/.aws/sso/cache/ at all.
   * Captured: aws-cli/2.33.13, exit 255
   * Verbatim: "\nError loading SSO Token: Token for damm-sso does not exist\n"
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
   * Verbatim: "\nError when retrieving token from sso: Token has expired and refresh failed\n"
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
   * Verbatim: "\nError loading SSO Token: Token for https://... is invalid\n"
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

describe("parseAwsError — SSO auth-expired (legacy sso format, aws-cli 2.33.x)", () => {
  /**
   * State: legacy [profile] with sso_* keys (no [sso-session] stanza), no cached token.
   * Captured: aws-cli/2.33.13, exit 255
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
// SSO auth-expired — aws-cli >= 2.34.0 "aws: [ERROR]: " prefix
//
// From 2.34.0 onward the aws binary prepends "aws: [ERROR]: " before the
// error text. These fixtures are derived from the 2.33.x captures by
// inserting the prefix; they represent what CI's aws version produces.
// The same normalization regex in parseAwsError strips the prefix before
// applying the anchored patterns.
// ---------------------------------------------------------------------------

describe("parseAwsError — SSO auth-expired (new sso-session format, aws-cli >= 2.34.0 prefix)", () => {
  it("maps prefixed 'Error loading SSO Token: ... does not exist' to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("new-sso-session-no-cache-prefixed-2.34.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(result.code)).toBe(253);
  });

  it("maps prefixed 'Error when retrieving token from sso: Token has expired' to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("new-sso-session-expired-prefixed-2.34.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(result.code)).toBe(253);
  });

  it("maps prefixed 'Error loading SSO Token: ... is invalid' to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("new-sso-session-invalid-token-prefixed-2.34.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(result.code)).toBe(253);
  });
});

describe("parseAwsError — SSO auth-expired (legacy sso format, aws-cli >= 2.34.0 prefix)", () => {
  it("maps prefixed 'Error loading SSO Token: ... does not exist' (legacy) to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("legacy-sso-no-cache-prefixed-2.34.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(result.code)).toBe(253);
  });

  it("maps prefixed 'The SSO session associated...' (legacy) to AUTH_EXPIRED", () => {
    const stderr = ssoFixture("legacy-sso-expired-prefixed-2.34.txt");
    const result = parseAwsError(stderr, 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(awsExitCode(result.code)).toBe(253);
  });
});

// ---------------------------------------------------------------------------
// Precedence: SSO patterns checked BEFORE NO_CREDS_PATTERNS
//
// SSO_AUTH_EXPIRED_PATTERNS are checked before NO_CREDS_PATTERNS in
// parseAwsError (src/errors.ts). None of the 5 captured SSO messages match
// NO_CREDS_PATTERNS — no shadowing in either direction. These tests pin both
// the ordering and the non-overlap invariant.
//
// Ordering rationale: a never-logged-in SSO profile ("does not exist") must
// map to AUTH_EXPIRED, not NO_CREDENTIALS, because NO_CREDENTIALS suggests
// `aws configure` / static env vars — wrong advice for SSO.
// ---------------------------------------------------------------------------

describe("parseAwsError — SSO patterns checked before NO_CREDS_PATTERNS", () => {
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

  it("NO_CREDENTIALS patterns still work for non-SSO messages (SSO check does not over-reach)", () => {
    // Verify the SSO addition does NOT break the existing NO_CREDENTIALS detection.
    const result = parseAwsError("Unable to locate credentials", 255);
    expect(result.code).toBe("NO_CREDENTIALS");
  });

  it("botocore body echoing SSO text stays SERVICE_CLIENT_ERROR (anchors are load-bearing)", () => {
    // Without ^ anchors on the SSO patterns, these two botocore errors would flip to
    // AUTH_EXPIRED/253. The normalization strips the leading \n and optional prefix,
    // then applies anchored matches to the bare message — keeping botocore errors safe.
    const withSSOBody = parseAwsError(
      "An error occurred (ResourceNotFoundException) when calling the DescribeInstance operation: Error loading SSO Token: not found",
      255,
    );
    expect(withSSOBody.code).toBe("SERVICE_CLIENT_ERROR");
    expect(withSSOBody.code).not.toBe("AUTH_EXPIRED");

    const withSSOInRoleName = parseAwsError(
      "An error occurred (ValidationError) when calling the AssumeRole operation: 1 validation error detected: Value 'Error loading SSO Token:' at 'roleSessionName' failed",
      255,
    );
    expect(withSSOInRoleName.code).toBe("SERVICE_CLIENT_ERROR");
    expect(withSSOInRoleName.code).not.toBe("AUTH_EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// NO_PROFILE_SELECTED interaction
//
// enrichNoCredsError (in aws.ts) upgrades NO_CREDENTIALS → NO_PROFILE_SELECTED.
// AUTH_EXPIRED is not in that upgrade path:
//   if (parsed.code !== "NO_CREDENTIALS" || context?.profile) return parsed;
// So AUTH_EXPIRED is always returned unchanged, regardless of profile selection.
// ---------------------------------------------------------------------------

describe("parseAwsError — AUTH_EXPIRED is not upgrade-able to NO_PROFILE_SELECTED", () => {
  it("SSO expired error stays AUTH_EXPIRED regardless of profile selection state", () => {
    const result = parseAwsError(ssoFixture("new-sso-session-expired.txt"), 255);
    expect(result.code).toBe("AUTH_EXPIRED");
    // NOT NO_PROFILE_SELECTED (which would suggest --profile rather than sso login)
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
