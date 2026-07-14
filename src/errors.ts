import { AxiError } from "axi-sdk-js";

export { AxiError };

/**
 * aws-axi error taxonomy — maps botocore stderr output to structured errors.
 * Exit code contract (mirrors spec §error-surfacing):
 *   252 = usage error
 *   253 = no-credentials / auth-expired
 *   254 = service-client-error
 *   255 = general / unknown
 *   127 = aws CLI not installed
 *     1 = remote-exec-error (remote shell exited non-zero; SSM API itself succeeded)
 *     0 = DryRunOperation (success signal)
 *
 * REMOTE_EXEC_ERROR (exit 1) is distinct from SERVICE_CLIENT_ERROR (exit 254):
 * the AWS SSM API call succeeded; the *remote shell command* failed.
 * An agent must distinguish "AWS denied my call" from "command ran but bombed".
 */
export type AwsErrorCode =
  | "USAGE_ERROR"
  | "NO_CREDENTIALS"
  | "AUTH_EXPIRED"
  | "SERVICE_CLIENT_ERROR"
  | "AWS_NOT_INSTALLED"
  | "DRY_RUN_SUCCESS"
  | "REMOTE_EXEC_ERROR"
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
]);

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

    // Expired / auth failures
    if (AUTH_EXPIRED_BOTO_CODES.has(botoCode)) {
      return {
        code: "AUTH_EXPIRED",
        botoCode,
        operation,
        message: `AWS credentials have expired (${botoCode})`,
        suggestions: [
          "Run `aws sso login` to refresh credentials",
          "Or renew your temporary credentials via `aws sts assume-role`",
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

/** Map an AwsErrorCode to the aws-axi process exit code. */
export function awsExitCode(code: AwsErrorCode): number {
  switch (code) {
    case "USAGE_ERROR":
      return 252;
    case "NO_CREDENTIALS":
      return 253;
    case "AUTH_EXPIRED":
      return 253;
    case "SERVICE_CLIENT_ERROR":
      return 254;
    case "DRY_RUN_SUCCESS":
      return 0;
    case "AWS_NOT_INSTALLED":
      return 127;
    case "REMOTE_EXEC_ERROR":
      // exit 1 = conventional "command failed"; distinct from 254 (AWS API error)
      return 1;
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
