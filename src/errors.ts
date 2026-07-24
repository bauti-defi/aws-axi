import { AxiError } from "axi-sdk-js";

export { AxiError };

/**
 * aws-axi error taxonomy — maps botocore stderr output to structured errors.
 * Exit code contract (mirrors spec §error-surfacing):
 *   252 = usage error / no region configured
 *   253 = no-credentials / auth-expired
 *   254 = service-client-error (incl. SSM delivery failures: TimedOut, Undeliverable, etc.)
 *   255 = general / unknown
 *   127 = aws CLI not installed
 *   250 = SSM -1 sentinel (invocation not run; ResponseCode=-1 outside a delivery-failure state)
 * 1..249 = remote shell exit code propagated verbatim (ssh/docker exec semantics)
 *     0 = success (also DryRunOperation success signal)
 *
 * SSM-specific exits (1..249, 250, 254) are set directly on process.exitCode by
 * ssmCommand — they do not map through AwsErrorCode / awsExitCode.
 */
export type AwsErrorCode =
  | "USAGE_ERROR"
  | "NO_REGION"
  | "NO_CREDENTIALS"
  | "NO_PROFILE_SELECTED"
  | "AUTH_EXPIRED"
  | "SERVICE_CLIENT_ERROR"
  | "AWS_NOT_INSTALLED"
  | "DRY_RUN_SUCCESS"
  | "UNKNOWN";

export interface ParsedAwsError {
  readonly code: AwsErrorCode;
  readonly botoCode: string | undefined;
  readonly operation: string | undefined;
  readonly message: string;
  readonly suggestions: readonly string[];
}

// Botocore error format: "An error occurred (<Code>) when calling the <Op> operation: <msg>"
const BOTOCORE_RE =
  /An error occurred \(([^)]+)\) when calling the (\w+) operation: ([\s\S]*)/;

const NO_CREDS_PATTERNS: RegExp[] = [
  /Unable to locate credentials/i,
  /No credentials.*configured/i,
  /could not be found in any of the following locations/i,
];

const AUTH_EXPIRED_BOTO_CODES = new Set([
  "ExpiredTokenException",
  "TokenExpiredException",
  "ExpiredToken",
  "AuthFailure",
  // NOTE: "UnauthorizedSSOTokenError" was previously listed here but is dead code.
  // It is a botocore Python exception *class* name, not a service API error code.
  // BOTOCORE_RE matches only the "<Code>" field from
  //   "An error occurred (<Code>) when calling the <Op> operation: ..."
  // which comes from the service HTTP response — a Python class name never
  // appears in that position. The role-not-assigned case (UnauthorizedException
  // from sso:GetRoleCredentials) is handled by SSO_AUTH_EXPIRED_PATTERNS above,
  // because the aws CLI emits one of the SSO provider-layer messages before the
  // botocore format is reached.
]);

/**
 * SSO-provider error patterns captured from aws-cli/2.33.13 on macOS.
 *
 * These come from the aws CLI's SSO token provider layer — NOT from botocore's
 * "An error occurred (...)" format — so they never reach AUTH_EXPIRED_BOTO_CODES.
 * They are checked BEFORE NO_CREDS_PATTERNS and BOTOCORE_RE.
 *
 * Checked before NO_CREDS_PATTERNS as a defensive ordering: none of the captured
 * messages match NO_CREDS_PATTERNS today, but SSO messages are semantically
 * distinct from generic "no credentials" (they always mean "re-run sso login"),
 * and explicit ordering prevents future message changes from shadowing them.
 *
 * Scenarios covered:
 *   "Error loading SSO Token: Token for <session> does not exist"   (no cached token)
 *   "Error loading SSO Token: Token for <url> is invalid"           (malformed token)
 *   "Error when retrieving token from sso: Token has expired..."    (expired, new format)
 *   "The SSO session associated with this profile has expired..."   (expired, legacy format)
 */
const SSO_AUTH_EXPIRED_PATTERNS: RegExp[] = [
  /^Error loading SSO Token:/i,
  /^Error when retrieving token from sso:/i,
  /^The SSO session associated with this profile has expired/i,
];

/**
 * Region-not-configured patterns — captured from real aws binaries:
 *   aws-cli/2.33.13: no dedicated handler → plain text
 *   aws-cli/2.34.0+: NoRegionErrorHandler → enhanced format (default since 2.34.0)
 *
 * Two stderr shapes (both after normalization — leading \n + "aws: [ERROR]: " stripped):
 *
 *   2.33.x:   "You must specify a region. You can also configure your region..."
 *   ≥ 2.34.0: "An error occurred (NoRegion): You must specify a region..."
 *
 * The ≥ 2.34.0 form does NOT match BOTOCORE_RE because it lacks "when calling
 * the <Op> operation:" — it falls through to this check. The 2.33.x form never
 * matched BOTOCORE_RE either. Both are caught by the single anchored pattern below.
 *
 * ^ is load-bearing. Removing it would cause region wording inside botocore
 * error bodies (e.g. "You must specify a region for this resource" inside an
 * InvalidParameterValue body) to flip from SERVICE_CLIENT_ERROR/254 to NO_REGION.
 * The (?:An error occurred \(NoRegion\): )? optional prefix is specific enough
 * that no other message body can false-positive through it.
 *
 * Fixture verification: byte-exact captures from official amazon/aws-cli
 * containers (2.33.13 and 2.34.0/2.36.2/2.36.7 — the ≥2.34 variants are
 * byte-identical to each other). See test/fixtures/region-errors/README.md.
 *
 * Adversarial invariants (tested in test/errors.test.ts):
 *   - region message (both forms) must never classify as AUTH_EXPIRED
 *   - SSO expired message must never classify as NO_REGION
 *   - botocore body echoing region wording must stay SERVICE_CLIENT_ERROR
 */
const NO_REGION_PATTERNS: RegExp[] = [
  /^(?:An error occurred \(NoRegion\): )?You must specify a region/i,
];

/** Parse a raw stderr string + exit code into a structured error descriptor. */
export function parseAwsError(
  stderr: string,
  exitCode: number,
): ParsedAwsError {
  // ── aws not installed ──────────────────────────────────────────────────
  if (stderr === "ENOENT") {
    return {
      code: "AWS_NOT_INSTALLED",
      botoCode: undefined,
      operation: undefined,
      message: "aws CLI is not installed — see https://aws.amazon.com/cli/",
      suggestions: [],
    };
  }

  // ── SSO token missing/expired/invalid ─────────────────────────────────────
  // Checked before NO_CREDS_PATTERNS (see SSO_AUTH_EXPIRED_PATTERNS comment above).
  //
  // Normalize before matching:
  //   1. Leading blank line: every aws stderr begins with \n (the aws binary
  //      writes an empty line before the error text). src/aws.ts passes stderr
  //      untrimmed, so ^-anchored patterns must be applied to the normalized form.
  //   2. aws-cli >= 2.34.0 prefixes "aws: [ERROR]: " before the error text.
  //      aws-cli <= 2.33.x does not. Both shapes must reach AUTH_EXPIRED.
  //
  // Do NOT delete the ^ anchors as a shortcut — unanchored patterns would
  // over-match botocore errors whose *message body* echoes SSO phrasing:
  //   "An error occurred (ResourceNotFoundException) ... Error loading SSO Token: not found"
  //   → should be SERVICE_CLIENT_ERROR/254, not AUTH_EXPIRED/253.
  const normalized = stderr.replace(/^\s*(?:aws:\s*\[ERROR\]:\s*)?/, "");
  if (SSO_AUTH_EXPIRED_PATTERNS.some((re) => re.test(normalized))) {
    return {
      code: "AUTH_EXPIRED",
      botoCode: undefined,
      operation: undefined,
      message: "SSO token is missing or expired — re-authentication required",
      suggestions: [
        "Run `aws sso login --profile <name>` to re-authenticate",
        "Replace <name> with the profile name you pass to aws-axi (--profile flag or AWS_PROFILE env)",
      ],
    };
  }

  // ── no credentials configured ──────────────────────────────────────────
  if (NO_CREDS_PATTERNS.some((re) => re.test(stderr))) {
    return {
      code: "NO_CREDENTIALS",
      botoCode: undefined,
      operation: undefined,
      message: "No AWS credentials configured",
      suggestions: [
        "Run `aws sso login` to authenticate via SSO",
        "Or run `aws configure` to set static credentials",
        "Or set the AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables",
      ],
    };
  }

  // ── botocore structured error ──────────────────────────────────────────
  const botoMatch = BOTOCORE_RE.exec(stderr);
  if (botoMatch) {
    const botoCode = botoMatch[1] ?? "";
    const operation = botoMatch[2] ?? "";
    const detail = (botoMatch[3] ?? "").trim();

    // DryRunOperation = the permission check succeeded
    if (botoCode === "DryRunOperation") {
      return {
        code: "DRY_RUN_SUCCESS",
        botoCode,
        operation,
        message: `DryRun succeeded — the operation would have succeeded without --dry-run`,
        suggestions: [],
      };
    }

    // Expired / auth failures (non-SSO credential types: AssumeRole, static keys, etc.)
    if (AUTH_EXPIRED_BOTO_CODES.has(botoCode)) {
      return {
        code: "AUTH_EXPIRED",
        botoCode,
        operation,
        message: `AWS credentials have expired (${botoCode})`,
        suggestions: [
          "Run `aws sso login --profile <name>` to refresh SSO credentials",
          "Or renew temporary credentials via `aws sts assume-role`",
        ],
      };
    }

    // General service-level client error
    return {
      code: "SERVICE_CLIENT_ERROR",
      botoCode,
      operation,
      message: detail
        ? `${botoCode} calling ${operation}: ${detail}`
        : `${botoCode} error calling ${operation}`,
      suggestions: [],
    };
  }

  // ── no region configured ──────────────────────────────────────────────
  // Checked after BOTOCORE_RE (this message never appears in botocore format)
  // and after SSO/NO_CREDS patterns (completely disjoint message space).
  // Applied to `normalized` (same variable as SSO checks above) so both
  // aws-cli 2.33.x and >= 2.34.0 prefix forms are matched.
  if (NO_REGION_PATTERNS.some((re) => re.test(normalized))) {
    return {
      code: "NO_REGION",
      botoCode: undefined,
      operation: undefined,
      message: "No AWS region configured — region is required for this operation",
      suggestions: [
        "Pass a region flag:    aws-axi <command> --region us-east-1",
        "Or export it:          export AWS_DEFAULT_REGION=us-east-1",
        "Or add to profile:     aws configure set region us-east-1 --profile <name>",
      ],
    };
  }

  // ── usage/validation errors ────────────────────────────────────────────
  if (exitCode === 252 || /^usage:/i.test(stderr)) {
    return {
      code: "USAGE_ERROR",
      botoCode: undefined,
      operation: undefined,
      message: firstLine(stderr) || "Usage error",
      suggestions: [],
    };
  }

  // ── fallback ───────────────────────────────────────────────────────────
  return {
    code: "UNKNOWN",
    botoCode: undefined,
    operation: undefined,
    message: firstLine(stderr) || `aws exited with code ${exitCode}`,
    suggestions: [],
  };
}

/**
 * Build a NO_PROFILE_SELECTED ParsedAwsError with a profile list.
 *
 * @param namedProfiles - profiles found in ~/.aws/config (default excluded)
 * @param defaultExists - whether a [default] section is present (even if credential-less)
 */
export function buildNoProfileSelectedError(
  namedProfiles: readonly string[],
  defaultExists: boolean,
): ParsedAwsError {
  // Use a concrete name only when the choice is unambiguous (exactly one profile).
  // With multiple profiles, a placeholder avoids silently suggesting a broken one.
  const example = namedProfiles.length === 1 ? (namedProfiles[0] ?? "<name>") : "<name>";

  const message = defaultExists
    ? "No AWS profile selected — the [default] profile has no usable credentials"
    : "No AWS profile selected and no [default] profile exists in ~/.aws/config";

  return {
    code: "NO_PROFILE_SELECTED",
    botoCode: undefined,
    operation: undefined,
    message,
    suggestions: [
      `Found profiles: ${namedProfiles.join(", ")}  (from ~/.aws/config)`,
      `Pass a profile:  aws-axi <command> --profile ${example}`,
      `Or export it:    export AWS_PROFILE=${example}`,
    ],
  };
}

/** Map an AwsErrorCode to the aws-axi process exit code. */
export function awsExitCode(code: AwsErrorCode): number {
  switch (code) {
    case "USAGE_ERROR":
      return 252;
    case "NO_REGION":
      return 252;
    case "NO_CREDENTIALS":
      return 253;
    case "NO_PROFILE_SELECTED":
      return 253;
    case "AUTH_EXPIRED":
      return 253;
    case "SERVICE_CLIENT_ERROR":
      return 254;
    case "DRY_RUN_SUCCESS":
      return 0;
    case "AWS_NOT_INSTALLED":
      return 127;
    default:
      return 255;
  }
}

/** Convert a ParsedAwsError into an AxiError for use with axi-sdk-js. */
export function mapAwsError(stderr: string, exitCode: number): AxiError {
  const parsed = parseAwsError(stderr, exitCode);
  return new AxiError(parsed.message, parsed.code, [...parsed.suggestions]);
}

/** Return a ready-made AxiError for the "aws not installed" case. */
export function awsNotInstalledError(): AxiError {
  return new AxiError(
    "aws CLI is not installed — see https://aws.amazon.com/cli/",
    "AWS_NOT_INSTALLED",
  );
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}
