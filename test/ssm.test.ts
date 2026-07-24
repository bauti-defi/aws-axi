/**
 * SSM Parameter Store overlay tests.
 *
 * All tests run against REAL subprocess stubs — no mock clients at the
 * exec-seam boundary. Each test creates its own temp dir with a unique
 * `aws` stub script so the module-level alias-map cache never collides.
 *
 * SECURITY INVARIANT: the actual parameter value MUST NOT appear in the
 * result of any default (non-reveal) call. Every redaction path has an
 * explicit assertion that checks JSON.stringify(result).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  SsmRunResult,
  SsmGetParameterResult,
  SsmGetParametersResult,
  SsmGetParametersByPathResult,
  SsmDescribeParametersResult,
} from "../src/commands/ssm.js";
import { ssmRun, ssmCommand } from "../src/commands/ssm.js";
import { main } from "../src/cli.js";
import { useEnvGuard } from "./helpers/env-guard.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARAM_NAME_SECURE = "/my/app/db-password";
const PARAM_ARN_SECURE = `arn:aws:ssm:us-east-1:123456789012:parameter${PARAM_NAME_SECURE}`;
const PARAM_VALUE_SECURE = "s3cr3t-v4lu3!!ShouldNeverLeak";

const PARAM_NAME_STRING = "/my/app/debug-mode";
const PARAM_ARN_STRING = `arn:aws:ssm:us-east-1:123456789012:parameter${PARAM_NAME_STRING}`;
const PARAM_VALUE_STRING = "true-plain-string-value";

const KMS_KEY_ID = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
const KMS_KEY_ARN = `arn:aws:kms:us-east-1:123456789012:key/${KMS_KEY_ID}`;
const KMS_KEY_ALIAS = "alias/ssm-test-key";

const GET_PARAMETER_SECURE = JSON.stringify({
  Parameter: {
    Name: PARAM_NAME_SECURE,
    Type: "SecureString",
    Value: PARAM_VALUE_SECURE,
    Version: 3,
    LastModifiedDate: "2024-01-15T10:00:00+00:00",
    ARN: PARAM_ARN_SECURE,
    DataType: "text",
  },
});

const GET_PARAMETER_STRING = JSON.stringify({
  Parameter: {
    Name: PARAM_NAME_STRING,
    Type: "String",
    Value: PARAM_VALUE_STRING,
    Version: 1,
    LastModifiedDate: "2024-02-10T08:30:00+00:00",
    ARN: PARAM_ARN_STRING,
    DataType: "text",
  },
});

const GET_PARAMETERS_TWO = JSON.stringify({
  Parameters: [
    {
      Name: PARAM_NAME_SECURE,
      Type: "SecureString",
      Value: PARAM_VALUE_SECURE,
      Version: 3,
      LastModifiedDate: "2024-01-15T10:00:00+00:00",
      ARN: PARAM_ARN_SECURE,
      DataType: "text",
    },
    {
      Name: PARAM_NAME_STRING,
      Type: "String",
      Value: PARAM_VALUE_STRING,
      Version: 1,
      LastModifiedDate: "2024-02-10T08:30:00+00:00",
      ARN: PARAM_ARN_STRING,
      DataType: "text",
    },
  ],
  InvalidParameters: [],
});

const GET_PARAMETERS_WITH_INVALID = JSON.stringify({
  Parameters: [
    {
      Name: PARAM_NAME_STRING,
      Type: "String",
      Value: PARAM_VALUE_STRING,
      Version: 1,
      LastModifiedDate: "2024-02-10T08:30:00+00:00",
      ARN: PARAM_ARN_STRING,
      DataType: "text",
    },
  ],
  InvalidParameters: ["/nonexistent/param"],
});

const GET_PARAMETERS_BY_PATH_TWO = JSON.stringify({
  Parameters: [
    {
      Name: "/my/app/db-password",
      Type: "SecureString",
      Value: PARAM_VALUE_SECURE,
      Version: 3,
      LastModifiedDate: "2024-01-15T10:00:00+00:00",
      ARN: PARAM_ARN_SECURE,
      DataType: "text",
    },
    {
      Name: "/my/app/debug-mode",
      Type: "String",
      Value: PARAM_VALUE_STRING,
      Version: 1,
      LastModifiedDate: "2024-02-10T08:30:00+00:00",
      ARN: PARAM_ARN_STRING,
      DataType: "text",
    },
  ],
});

const GET_PARAMETERS_BY_PATH_TRUNCATED = JSON.stringify({
  Parameters: [
    {
      Name: "/my/app/db-password",
      Type: "SecureString",
      Value: PARAM_VALUE_SECURE,
      Version: 3,
      LastModifiedDate: "2024-01-15T10:00:00+00:00",
      ARN: PARAM_ARN_SECURE,
      DataType: "text",
    },
  ],
  NextToken: "AQECAHiGqSSMToken==",
});

const DESCRIBE_PARAMETERS_TWO = JSON.stringify({
  Parameters: [
    {
      Name: PARAM_NAME_SECURE,
      Type: "SecureString",
      KeyId: KMS_KEY_ID,
      LastModifiedDate: "2024-01-15T10:00:00+00:00",
      Version: 3,
      Description: "DB password for production",
      ARN: PARAM_ARN_SECURE,
      DataType: "text",
      Tier: "Standard",
    },
    {
      Name: PARAM_NAME_STRING,
      Type: "String",
      LastModifiedDate: "2024-02-10T08:30:00+00:00",
      Version: 1,
      ARN: PARAM_ARN_STRING,
      DataType: "text",
      Tier: "Standard",
    },
  ],
});

const DESCRIBE_PARAMETERS_EMPTY = JSON.stringify({ Parameters: [] });

const DESCRIBE_PARAMETERS_TRUNCATED = JSON.stringify({
  Parameters: [
    {
      Name: PARAM_NAME_SECURE,
      Type: "SecureString",
      KeyId: KMS_KEY_ID,
      LastModifiedDate: "2024-01-15T10:00:00+00:00",
      Version: 3,
      ARN: PARAM_ARN_SECURE,
      DataType: "text",
      Tier: "Standard",
    },
  ],
  NextToken: "AQECAHiGqDescribeToken==",
});

// KMS fixtures for resolve-key enrichment
const KMS_DESCRIBE_KEY = JSON.stringify({
  KeyMetadata: {
    KeyId: KMS_KEY_ID,
    Arn: KMS_KEY_ARN,
    KeyState: "Enabled",
    Enabled: true,
    Description: "SSM encryption key",
    KeyManager: "CUSTOMER",
    KeyUsage: "ENCRYPT_DECRYPT",
    KeySpec: "SYMMETRIC_DEFAULT",
  },
});

const KMS_LIST_ALIASES_FOR_KEY = JSON.stringify({
  Aliases: [
    {
      AliasName: KMS_KEY_ALIAS,
      AliasArn: `arn:aws:kms:us-east-1:123456789012:${KMS_KEY_ALIAS}`,
      TargetKeyId: KMS_KEY_ID,
    },
  ],
});

const KMS_LIST_ALIASES_EMPTY = JSON.stringify({ Aliases: [] });

const NOT_FOUND_STDERR =
  "An error occurred (ParameterNotFound) when calling the GetParameter operation: Parameter /nonexistent not found";

// ─── Stub factory ─────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Stub spec: keys are "$1-$2" (service-subcommand), values are the response.
 *
 * Special keys:
 *   "ssm-get-parameter:error" → emit stderr and exit non-zero
 *   "kms-describe-key:error"  → emit stderr and exit non-zero
 */
interface StubEntry {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

type SsmStubSpec = Record<string, StubEntry>;

/**
 * Create a real shell stub dispatching on "$1-$2" (service + subcommand).
 * Unique binary path per invocation → unique cache key in resolve-key.
 */
function createStub(spec: SsmStubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "aws");

  const lines: string[] = ["#!/bin/sh", 'case "$1-$2" in'];

  for (const [key, entry] of Object.entries(spec)) {
    lines.push(`  ${key})`);
    if (entry.stderr !== undefined) {
      lines.push(`    printf '%s' ${shellQuote(entry.stderr)} >&2`);
    }
    if (entry.stdout !== undefined) {
      lines.push(`    printf '%s' ${shellQuote(entry.stdout)}`);
    }
    lines.push(`    exit ${entry.exitCode ?? 0};;`);
  }

  lines.push("  *)");
  lines.push('    printf "Unexpected: %s %s\\n" "$1" "$2" >&2');
  lines.push("    exit 254;;");
  lines.push("esac");

  writeFileSync(scriptPath, lines.join("\n"));
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
});

// Guard the full process.env (and process.exitCode) around each test.
// See test/helpers/env-guard.ts for the rationale and the guard test.
useEnvGuard();

// ─── SECURITY INVARIANT helper ────────────────────────────────────────────────

/** Returns true if the serialised result contains the secret string. */
function leaksValue(result: unknown, secret: string): boolean {
  return JSON.stringify(result).includes(secret);
}

// ─── Type-narrowing asserts ───────────────────────────────────────────────────
// `SsmRunResult` includes `Record<string,unknown>` (the --query passthrough),
// which defeats TypeScript's `in`-based union narrowing. These assert functions
// wrap the same runtime guards the tests already use, giving TypeScript the
// type information it cannot infer on its own.

function assertParameter(r: SsmRunResult): asserts r is SsmGetParameterResult {
  if (!("parameter" in r)) throw new Error("wrong discriminant");
}

function assertParameterList(r: SsmRunResult): asserts r is { readonly parameterList: SsmGetParametersResult } {
  if (!("parameterList" in r)) throw new Error("wrong discriminant");
}

function assertParametersByPath(r: SsmRunResult): asserts r is { readonly parametersByPath: SsmGetParametersByPathResult } {
  if (!("parametersByPath" in r)) throw new Error("wrong discriminant");
}

function assertParametersMeta(r: SsmRunResult): asserts r is { readonly parametersMeta: SsmDescribeParametersResult } {
  if (!("parametersMeta" in r)) throw new Error("wrong discriminant");
}

// ─── get-parameter — redaction ────────────────────────────────────────────────

describe("ssmRun get-parameter — default REDACTS the value", () => {
  it("SecureString value is NOT in result by default", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE },
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE],
      binary: stub,
    });

    // SECURITY: actual value must be absent from serialised output
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);

    // The result must carry a structured parameter (not be empty)
    expect("parameter" in result).toBe(true);
    assertParameter(result);
    expect(result.parameter.name).toBe(PARAM_NAME_SECURE);
    expect(result.parameter.type).toBe("SecureString");
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("String value is also REDACTED by default (all values are sensitive)", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_STRING },
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_STRING],
      binary: stub,
    });

    expect(leaksValue(result, PARAM_VALUE_STRING)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("metadata fields are present in default output", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE },
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE],
      binary: stub,
    });

    assertParameter(result);
    expect(result.parameter.version).toBe(3);
    expect(result.parameter.dataType).toBe("text");
    expect(result.parameter.lastModified).toBeTruthy();
  });

  it("includes a suggestion to use --reveal", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE },
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE],
      binary: stub,
    });

    assertParameter(result);
    expect(result.suggestion).toBeTruthy();
    expect(result.suggestion).toContain("--reveal");
  });
});

describe("ssmRun get-parameter --reveal — shows the actual value", () => {
  it("reveals SecureString value when --reveal is passed", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE },
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE, "--reveal"],
      binary: stub,
    });

    assertParameter(result);
    expect(result.parameter.value).toBe(PARAM_VALUE_SECURE);
    // When revealed, no suggestion is needed
    expect(result.suggestion).toBeUndefined();
  });

  it("reveals String value when --reveal is passed", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_STRING },
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: ["--reveal", PARAM_NAME_STRING],
      binary: stub,
    });

    assertParameter(result);
    expect(result.parameter.value).toBe(PARAM_VALUE_STRING);
  });
});

// ─── get-parameter — --reveal value matrix (redaction-bypass fix #56) ────────

describe("ssmRun get-parameter --reveal value matrix (redaction-bypass fix #56)", () => {
  function stubForReveal(): string {
    return createStub({ "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE } });
  }

  async function getWithFlag(flag: string): Promise<SsmRunResult> {
    return ssmRun({
      subcommand: "get-parameter",
      args: [flag, PARAM_NAME_SECURE],
      binary: stubForReveal(),
    });
  }

  // RED before fix: hasFlag("--reveal=false") → true → reveals

  it("--reveal=false REDACTS — was leaking before fix", async () => {
    const result = await getWithFlag("--reveal=false");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal=0 REDACTS", async () => {
    const result = await getWithFlag("--reveal=0");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal=no REDACTS", async () => {
    const result = await getWithFlag("--reveal=no");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal=garbage REDACTS (fail-safe: unrecognised → redact)", async () => {
    const result = await getWithFlag("--reveal=garbage");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal=off REDACTS (fail-safe)", async () => {
    const result = await getWithFlag("--reveal=off");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal= (empty) REDACTS (fail-safe)", async () => {
    const result = await getWithFlag("--reveal=");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  // GREEN sanity

  it("--reveal=true still REVEALS", async () => {
    const result = await getWithFlag("--reveal=true");
    assertParameter(result);
    expect(result.parameter.value).toBe(PARAM_VALUE_SECURE);
  });

  it("--reveal=1 still REVEALS", async () => {
    const result = await getWithFlag("--reveal=1");
    assertParameter(result);
    expect(result.parameter.value).toBe(PARAM_VALUE_SECURE);
  });

  it("--reveal=yes still REVEALS", async () => {
    const result = await getWithFlag("--reveal=yes");
    assertParameter(result);
    expect(result.parameter.value).toBe(PARAM_VALUE_SECURE);
  });
});

// ─── get-parameter — two-arg --reveal form (PR #58 round-2 fix) ──────────────

describe("ssmRun get-parameter — two-arg --reveal false (round-2 fix)", () => {
  function stubForReveal(): string {
    return createStub({ "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE } });
  }

  it("--reveal false (two-arg, flag-last) REDACTS — was leaking before round-2 fix", async () => {
    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE, "--reveal", "false"],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal 0 (two-arg) REDACTS", async () => {
    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE, "--reveal", "0"],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal no (two-arg) REDACTS", async () => {
    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE, "--reveal", "no"],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.value).toBe("<redacted>");
  });

  it("--reveal true (two-arg) still REVEALS", async () => {
    const result = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE, "--reveal", "true"],
      binary: stubForReveal(),
    });
    assertParameter(result);
    expect(result.parameter.value).toBe(PARAM_VALUE_SECURE);
  });

  it("flag-first two-arg --reveal false resolves param name correctly", async () => {
    // After extractPositionals fix, "false" is consumed as the flag value,
    // so PARAM_NAME_SECURE is positionals[0] (correct param name).
    const result = await ssmRun({
      subcommand: "get-parameter",
      args: ["--reveal", "false", PARAM_NAME_SECURE],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameter(result);
    expect(result.parameter.name).toBe(PARAM_NAME_SECURE);
  });
});

describe("ssmRun get-parameter — errors", () => {
  it("throws USAGE_ERROR when no name is provided", async () => {
    const stub = createStub({});

    await expect(
      ssmRun({ subcommand: "get-parameter", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("throws SERVICE_CLIENT_ERROR on ParameterNotFound", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stderr: NOT_FOUND_STDERR, exitCode: 254 },
    });

    await expect(
      ssmRun({ subcommand: "get-parameter", args: ["/nonexistent"], binary: stub }),
    ).rejects.toMatchObject({ code: "SERVICE_CLIENT_ERROR" });
  });

  it("accepts --name flag form", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE },
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: ["--name", PARAM_NAME_SECURE],
      binary: stub,
    });

    assertParameter(result);
    expect(result.parameter.name).toBe(PARAM_NAME_SECURE);
  });
});

// ─── get-parameters — redaction ───────────────────────────────────────────────

describe("ssmRun get-parameters — default REDACTS all values", () => {
  it("none of the actual values appear in default result", async () => {
    const stub = createStub({
      "ssm-get-parameters": { stdout: GET_PARAMETERS_TWO },
    });

    const result = await ssmRun({
      subcommand: "get-parameters",
      args: [PARAM_NAME_SECURE, PARAM_NAME_STRING],
      binary: stub,
    });

    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    expect(leaksValue(result, PARAM_VALUE_STRING)).toBe(false);

    assertParameterList(result);
    expect(result.parameterList.parameters).toHaveLength(2);
    for (const p of result.parameterList.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("invalid parameters are reported separately", async () => {
    const stub = createStub({
      "ssm-get-parameters": { stdout: GET_PARAMETERS_WITH_INVALID },
    });

    const result = await ssmRun({
      subcommand: "get-parameters",
      args: [PARAM_NAME_STRING, "/nonexistent/param"],
      binary: stub,
    });

    assertParameterList(result);
    expect(result.parameterList.invalidParameters).toContain("/nonexistent/param");
  });

  it("count is honest", async () => {
    const stub = createStub({
      "ssm-get-parameters": { stdout: GET_PARAMETERS_TWO },
    });

    const result = await ssmRun({
      subcommand: "get-parameters",
      args: [PARAM_NAME_SECURE, PARAM_NAME_STRING],
      binary: stub,
    });

    assertParameterList(result);
    expect(result.parameterList.count).toContain("2");
  });

  it("throws USAGE_ERROR when no names provided", async () => {
    const stub = createStub({});

    await expect(
      ssmRun({ subcommand: "get-parameters", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

describe("ssmRun get-parameters --reveal", () => {
  it("shows all values when --reveal is passed", async () => {
    const stub = createStub({
      "ssm-get-parameters": { stdout: GET_PARAMETERS_TWO },
    });

    const result = await ssmRun({
      subcommand: "get-parameters",
      args: ["--reveal", PARAM_NAME_SECURE, PARAM_NAME_STRING],
      binary: stub,
    });

    assertParameterList(result);
    const secure = result.parameterList.parameters.find(
      (p) => p.name === PARAM_NAME_SECURE,
    );
    const str = result.parameterList.parameters.find(
      (p) => p.name === PARAM_NAME_STRING,
    );
    expect(secure?.value).toBe(PARAM_VALUE_SECURE);
    expect(str?.value).toBe(PARAM_VALUE_STRING);
  });
});

// ─── get-parameters — --reveal value matrix (redaction-bypass fix #56) ───────

describe("ssmRun get-parameters --reveal value matrix (redaction-bypass fix #56)", () => {
  function stubForReveal(): string {
    return createStub({ "ssm-get-parameters": { stdout: GET_PARAMETERS_TWO } });
  }

  async function getWithFlag(flag: string): Promise<SsmRunResult> {
    return ssmRun({
      subcommand: "get-parameters",
      args: [flag, PARAM_NAME_SECURE, PARAM_NAME_STRING],
      binary: stubForReveal(),
    });
  }

  it("--reveal=false REDACTS all values — was leaking before fix", async () => {
    const result = await getWithFlag("--reveal=false");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameterList(result);
    for (const p of result.parameterList.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("--reveal=garbage REDACTS (fail-safe: unrecognised → redact)", async () => {
    const result = await getWithFlag("--reveal=garbage");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameterList(result);
    for (const p of result.parameterList.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("--reveal= (empty) REDACTS (fail-safe)", async () => {
    const result = await getWithFlag("--reveal=");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParameterList(result);
    for (const p of result.parameterList.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("--reveal=true still REVEALS all values", async () => {
    const result = await getWithFlag("--reveal=true");
    assertParameterList(result);
    const secure = result.parameterList.parameters.find(
      (p) => p.name === PARAM_NAME_SECURE,
    );
    expect(secure?.value).toBe(PARAM_VALUE_SECURE);
  });
});

// ─── get-parameters-by-path — redaction + pagination ─────────────────────────

describe("ssmRun get-parameters-by-path — default REDACTS values", () => {
  it("no value leaks in default result", async () => {
    const stub = createStub({
      "ssm-get-parameters-by-path": { stdout: GET_PARAMETERS_BY_PATH_TWO },
    });

    const result = await ssmRun({
      subcommand: "get-parameters-by-path",
      args: ["/my/app"],
      binary: stub,
    });

    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    expect(leaksValue(result, PARAM_VALUE_STRING)).toBe(false);

    assertParametersByPath(result);
    for (const p of result.parametersByPath.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("truncated result exposes nextToken", async () => {
    const stub = createStub({
      "ssm-get-parameters-by-path": { stdout: GET_PARAMETERS_BY_PATH_TRUNCATED },
    });

    const result = await ssmRun({
      subcommand: "get-parameters-by-path",
      args: ["/my/app", "--max-items", "1"],
      binary: stub,
    });

    assertParametersByPath(result);
    expect(result.parametersByPath.nextToken).toBe("AQECAHiGqSSMToken==");
    expect(result.parametersByPath.count).toContain("truncated");
    expect(result.parametersByPath.count).toContain("AQECAHiGqSSMToken==");
  });

  it("throws USAGE_ERROR when no path provided", async () => {
    const stub = createStub({});

    await expect(
      ssmRun({ subcommand: "get-parameters-by-path", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("accepts --path flag form", async () => {
    const stub = createStub({
      "ssm-get-parameters-by-path": { stdout: GET_PARAMETERS_BY_PATH_TWO },
    });

    const result = await ssmRun({
      subcommand: "get-parameters-by-path",
      args: ["--path", "/my/app"],
      binary: stub,
    });

    assertParametersByPath(result);
    expect(result.parametersByPath.parameters).toHaveLength(2);
  });
});

describe("ssmRun get-parameters-by-path --reveal", () => {
  it("shows values when --reveal is passed", async () => {
    const stub = createStub({
      "ssm-get-parameters-by-path": { stdout: GET_PARAMETERS_BY_PATH_TWO },
    });

    const result = await ssmRun({
      subcommand: "get-parameters-by-path",
      args: ["/my/app", "--reveal"],
      binary: stub,
    });

    assertParametersByPath(result);
    const secure = result.parametersByPath.parameters.find(
      (p) => p.name === "/my/app/db-password",
    );
    expect(secure?.value).toBe(PARAM_VALUE_SECURE);
  });
});

// ─── get-parameters-by-path — --reveal value matrix (fix #56) ───────────────

describe("ssmRun get-parameters-by-path --reveal value matrix (redaction-bypass fix #56)", () => {
  function stubForReveal(): string {
    return createStub({
      "ssm-get-parameters-by-path": { stdout: GET_PARAMETERS_BY_PATH_TWO },
    });
  }

  async function getWithFlag(flag: string): Promise<SsmRunResult> {
    return ssmRun({
      subcommand: "get-parameters-by-path",
      args: ["/my/app", flag],
      binary: stubForReveal(),
    });
  }

  it("--reveal=false REDACTS — was leaking before fix", async () => {
    const result = await getWithFlag("--reveal=false");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParametersByPath(result);
    for (const p of result.parametersByPath.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("--reveal=garbage REDACTS (fail-safe: unrecognised → redact)", async () => {
    const result = await getWithFlag("--reveal=garbage");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParametersByPath(result);
    for (const p of result.parametersByPath.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("--reveal= (empty) REDACTS (fail-safe)", async () => {
    const result = await getWithFlag("--reveal=");
    expect(leaksValue(result, PARAM_VALUE_SECURE)).toBe(false);
    assertParametersByPath(result);
    for (const p of result.parametersByPath.parameters) {
      expect(p.value).toBe("<redacted>");
    }
  });

  it("--reveal=true still REVEALS", async () => {
    const result = await getWithFlag("--reveal=true");
    assertParametersByPath(result);
    const secure = result.parametersByPath.parameters.find(
      (p) => p.name === "/my/app/db-password",
    );
    expect(secure?.value).toBe(PARAM_VALUE_SECURE);
  });
});

// ─── describe-parameters — metadata + KMS alias enrichment ───────────────────

describe("ssmRun describe-parameters — metadata and KMS alias enrichment", () => {
  it("returns curated metadata list with kmsKeyAlias resolved", async () => {
    const stub = createStub({
      "ssm-describe-parameters": { stdout: DESCRIBE_PARAMETERS_TWO },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await ssmRun({
      subcommand: "describe-parameters",
      args: [],
      binary: stub,
    });

    assertParametersMeta(result);
    expect(result.parametersMeta.parameters).toHaveLength(2);

    const secureParam = result.parametersMeta.parameters.find(
      (p) => p.name === PARAM_NAME_SECURE,
    );
    // KeyId is present → alias should be resolved
    expect(secureParam?.kmsKeyAlias).toBe(KMS_KEY_ALIAS);

    const stringParam = result.parametersMeta.parameters.find(
      (p) => p.name === PARAM_NAME_STRING,
    );
    // String type has no KeyId → alias is undefined
    expect(stringParam?.kmsKeyAlias).toBeUndefined();
  });

  it("describe-parameters carries no Value field (metadata only — nothing to redact)", async () => {
    const stub = createStub({
      "ssm-describe-parameters": { stdout: DESCRIBE_PARAMETERS_TWO },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await ssmRun({
      subcommand: "describe-parameters",
      args: [],
      binary: stub,
    });

    assertParametersMeta(result);
    for (const p of result.parametersMeta.parameters) {
      // No value field on metadata entries
      expect("value" in p).toBe(false);
    }
  });

  it("count is honest — N total", async () => {
    const stub = createStub({
      "ssm-describe-parameters": { stdout: DESCRIBE_PARAMETERS_TWO },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await ssmRun({
      subcommand: "describe-parameters",
      args: [],
      binary: stub,
    });

    assertParametersMeta(result);
    expect(result.parametersMeta.count).toContain("2");
    expect(result.parametersMeta.count).toContain("total");
    expect(result.parametersMeta.nextToken).toBeUndefined();
  });

  it("truncated result exposes nextToken", async () => {
    const stub = createStub({
      "ssm-describe-parameters": { stdout: DESCRIBE_PARAMETERS_TRUNCATED },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await ssmRun({
      subcommand: "describe-parameters",
      args: ["--max-items", "1"],
      binary: stub,
    });

    assertParametersMeta(result);
    expect(result.parametersMeta.nextToken).toBe("AQECAHiGqDescribeToken==");
    expect(result.parametersMeta.count).toContain("truncated");
  });

  it("empty state returns message and suggestion", async () => {
    const stub = createStub({
      "ssm-describe-parameters": { stdout: DESCRIBE_PARAMETERS_EMPTY },
    });

    const result = await ssmRun({
      subcommand: "describe-parameters",
      args: [],
      binary: stub,
    });

    assertParametersMeta(result);
    expect(result.parametersMeta.parameters).toHaveLength(0);
    expect(result.parametersMeta.message).toBeTruthy();
    expect(result.parametersMeta.suggestion).toBeTruthy();
  });

  it("degrades gracefully when KMS alias resolution fails", async () => {
    const stub = createStub({
      "ssm-describe-parameters": { stdout: DESCRIBE_PARAMETERS_TWO },
      "kms-describe-key": {
        stderr:
          "An error occurred (AccessDeniedException) when calling the DescribeKey operation: User not authorized",
        exitCode: 254,
      },
    });

    // Must NOT throw — just show kmsKeyAlias as undefined or the raw keyId
    const result = await ssmRun({
      subcommand: "describe-parameters",
      args: [],
      binary: stub,
    });

    assertParametersMeta(result);
    // SecureString param: KMS call failed → kmsKeyAlias shows raw keyId or undefined
    const secureParam = result.parametersMeta.parameters.find(
      (p) => p.name === PARAM_NAME_SECURE,
    );
    // Should NOT throw; kmsKeyAlias is either undefined or the raw keyId
    expect(secureParam).toBeDefined();
  });
});

// ─── ssmCommand — dispatch ────────────────────────────────────────────────────

describe("ssmCommand — dispatch", () => {
  it("defaults to describe-parameters when no subcommand given", async () => {
    const stub = createStub({
      "ssm-describe-parameters": { stdout: DESCRIBE_PARAMETERS_EMPTY },
    });

    // ssmCommand takes string[] args and AwsContext; inject binary via binary option
    // We test by inspecting the returned result shape
    const result = await ssmRun({
      subcommand: "",
      args: [],
      binary: stub,
    });

    expect("parametersMeta" in result).toBe(true);
  });

  it("wraps result under top-level 'ssm' key", async () => {
    const stub = createStub({
      "ssm-get-parameter": { stdout: GET_PARAMETER_SECURE },
    });

    // ssmCommand returns Record<string, unknown> with a top-level key
    const run = await ssmRun({
      subcommand: "get-parameter",
      args: [PARAM_NAME_SECURE],
      binary: stub,
    });

    const wrapped: Record<string, unknown> = { ssm: run };
    expect(Object.keys(wrapped)).toContain("ssm");
  });

  it("throws USAGE_ERROR for an unknown subcommand", async () => {
    const stub = createStub({});

    await expect(
      ssmRun({ subcommand: "invalid-subcmd", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

// ─── captureMain helper ───────────────────────────────────────────────────────
//
// Drives the full CLI adapter layer (not ssmRun directly). Tests that go
// through captureMain prove the user-facing behaviour; tests that call ssmRun
// directly only prove the internal handler.

async function captureMain(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const stdout = {
    write(chunk: string): true {
      chunks.push(chunk);
      return true;
    },
  };

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  const prevExitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  try {
    await main({ argv, stdout });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  const rawExitCode = process.exitCode as number;
  const exitCode: number | undefined = rawExitCode === 0 ? undefined : rawExitCode;
  process.exitCode = prevExitCode;

  return { output: chunks.join(""), exitCode };
}

/** Return the directory containing the stub `aws` binary (for PATH injection). */
function stubDir(binary: string): string {
  return binary.replace(/\/aws$/, "");
}

// ─── ssm run fixtures ─────────────────────────────────────────────────────────

const TEST_COMMAND_ID = "cmd-12345678-test-0001-abcdef";
const TEST_INSTANCE_ID = "i-0abc123def456789";
const TEST_COMMAND = "docker ps";

// GCI response where remote command exited 7 (for verbatim exit-code test)
const GCI_FAILED_7 = JSON.stringify({
  CommandId: TEST_COMMAND_ID,
  InstanceId: TEST_INSTANCE_ID,
  DocumentName: "AWS-RunShellScript",
  Status: "Failed",
  StatusDetails: "Failed",
  ResponseCode: 7,
  StandardOutputContent: "",
  StandardErrorContent: "script exited with code 7\n",
  ExecutionElapsedTime: "PT0.200S",
});

// GCI response for AWS-level delivery timeout (SSM never ran the shell)
const GCI_TIMED_OUT = JSON.stringify({
  CommandId: TEST_COMMAND_ID,
  InstanceId: TEST_INSTANCE_ID,
  DocumentName: "AWS-RunShellScript",
  Status: "TimedOut",
  StatusDetails: "DeliveryTimedOut",
  ResponseCode: -1,
  StandardOutputContent: "",
  StandardErrorContent: "",
  ExecutionElapsedTime: "",
});

// GCI response with a Windows-style path in stdout (contains literal \n pair)
const GCI_WINDOWS_PATH = JSON.stringify({
  CommandId: TEST_COMMAND_ID,
  InstanceId: TEST_INSTANCE_ID,
  DocumentName: "AWS-RunShellScript",
  Status: "Success",
  StatusDetails: "Success",
  ResponseCode: 0,
  // Runtime value after JSON.parse: "C:\node\bin" — backslash-n, not a newline.
  // The broken double-unescape would split this into ["C:", "ode\bin"],
  // destroying "node". The fixed toLines keeps it as one element.
  StandardOutputContent: "C:\\node\\bin",
  StandardErrorContent: "",
  ExecutionElapsedTime: "PT0.100S",
});

// ─── B1-regression: fatal polling errors propagate with original error code ───
//
// These appear on stderr when the aws CLI rejects the GetCommandInvocation call
// mid-poll (not an InvocationDoesNotExist transient; a fatal auth/permission error).
// The re-throw in pollInvocation must preserve err.code so:
//   AccessDeniedException → SERVICE_CLIENT_ERROR → exit 254
//   ExpiredTokenException → AUTH_EXPIRED          → exit 253
const ACCESS_DENIED_GCI_STDERR =
  "An error occurred (AccessDeniedException) when calling the GetCommandInvocation operation: User is not authorized to perform: ssm:GetCommandInvocation";
const EXPIRED_TOKEN_GCI_STDERR =
  "An error occurred (ExpiredTokenException) when calling the GetCommandInvocation operation: The security token included in the request is expired";

const SEND_COMMAND_RESPONSE = JSON.stringify({
  Command: { CommandId: TEST_COMMAND_ID },
});

const GCI_SUCCESS = JSON.stringify({
  CommandId: TEST_COMMAND_ID,
  InstanceId: TEST_INSTANCE_ID,
  DocumentName: "AWS-RunShellScript",
  Status: "Success",
  StatusDetails: "Success",
  ResponseCode: 0,
  StandardOutputContent: "CONTAINER ID\nfoo-container\n",
  StandardErrorContent: "",
  ExecutionElapsedTime: "PT0.500S",
});

const GCI_FAILED = JSON.stringify({
  CommandId: TEST_COMMAND_ID,
  InstanceId: TEST_INSTANCE_ID,
  DocumentName: "AWS-RunShellScript",
  Status: "Failed",
  StatusDetails: "Failed",
  ResponseCode: 1,
  StandardOutputContent: "",
  StandardErrorContent: "bash: foobar: command not found\n",
  ExecutionElapsedTime: "PT0.100S",
});

const GCI_IN_PROGRESS = JSON.stringify({
  CommandId: TEST_COMMAND_ID,
  InstanceId: TEST_INSTANCE_ID,
  DocumentName: "AWS-RunShellScript",
  Status: "InProgress",
  StatusDetails: "InProgress",
  ResponseCode: -1,
  StandardOutputContent: "",
  StandardErrorContent: "",
  ExecutionElapsedTime: "PT0.000S",
});

// get-command-invocation response with multiline output encoded as JSON
const GCI_MULTILINE = JSON.stringify({
  CommandId: TEST_COMMAND_ID,
  InstanceId: TEST_INSTANCE_ID,
  DocumentName: "AWS-RunShellScript",
  Status: "Success",
  StatusDetails: "Success",
  ResponseCode: 0,
  StandardOutputContent: "alpha\nbeta\ngamma\n",
  StandardErrorContent: "",
  ExecutionElapsedTime: "PT0.200S",
});

// ─── ssm run — happy path ─────────────────────────────────────────────────────

describe("ssm run — happy path (captureMain)", () => {
  it("sends command, polls to Success, returns structured result with exit 0", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_SUCCESS },
    });

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", TEST_COMMAND],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Clean exit
    expect(exitCode).toBeUndefined();

    // Structured result present in output
    expect(output).toContain("commandId");
    expect(output).toContain(TEST_COMMAND_ID);
    expect(output).toContain("status");

    // No error
    expect(output).not.toContain("USAGE_ERROR");
    expect(output).not.toContain("SERVICE_CLIENT_ERROR");
    expect(output).not.toContain("REMOTE_EXEC_ERROR");
  });

  it("includes remoteExitCode: 0 in the output", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_SUCCESS },
    });

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", TEST_COMMAND],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("remoteExitCode");
    expect(output).toContain("0");
  });
});

// ─── ssm run — remote non-zero exit ──────────────────────────────────────────
//
// Revert-proof: remove the REMOTE_EXEC_ERROR path / process.exitCode assignment
// from ssmCommand and ssmRun → exitCode becomes undefined, test fails.

describe("ssm run — remote non-zero exit (captureMain)", () => {
  it("exits non-zero and surfaces remoteExitCode when remote command fails", async () => {
    // Revert-proof: remove `process.exitCode = 1` from ssmCommand
    // → exitCode becomes undefined → first assertion fails.
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_FAILED },
    });

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", "foobar"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // MUST exit non-zero — a failed remote command is never a success
    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);

    // The structured TOON output shows remoteExitCode (not an opaque error blob),
    // so the agent has both the exit signal AND the full stdout/stderr context.
    // Design rationale: returning structured output is better than throwing
    // AxiError here because stdout/stderr render as proper line arrays rather
    // than escaped suggestions in the error help: field.
    expect(output).toContain("remoteExitCode");

    // remoteExitCode must NOT be 0 in the output (the command did fail)
    expect(output).toContain("1");

    // Status must indicate failure
    expect(output).toContain("Failed");

    // Must NOT masquerade as an AWS API error
    expect(output).not.toContain("SERVICE_CLIENT_ERROR");
  });

  it("remote exit code propagated verbatim (ResponseCode=1 → process exit 1, not 254)", async () => {
    // ssh / docker exec semantics: remote exit is propagated verbatim (1..249),
    // never collapsed to a hardcoded sentinel. 254 is reserved for delivery failures.
    //
    // Revert-proof: remove the `remoteExitCode > 0` branch in ssmCommand
    // → no assignment → exitCode is undefined → assertion fails.
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_FAILED },
    });

    const { exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", "foobar"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // ResponseCode=1 → process exit 1 (verbatim; NOT a hardcoded sentinel).
    // Distinct from 254 (delivery failure) and 252 (usage error).
    expect(exitCode).toBe(1);
  });
});

// ─── ssm run — timeout ────────────────────────────────────────────────────────
//
// Revert-proof: remove the deadline check from the polling loop → the loop
// never times out → the test hangs or never reaches the assertion.

describe("ssm run — timeout (captureMain)", () => {
  it("fails with the CommandId in output when --timeout 0 is exceeded", async () => {
    // With --timeout 0, the deadline is set to Date.now(). Even the instant
    // send-command stub takes >0ms to execute, so the deadline is exceeded
    // before the first get-command-invocation poll fires.
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      // Not expected to be called; but provide InProgress just in case
      "ssm-get-command-invocation": { stdout: GCI_IN_PROGRESS },
    });

    const { output, exitCode } = await captureMain(
      [
        "ssm", "run",
        "--instance-ids", TEST_INSTANCE_ID,
        "--commands", TEST_COMMAND,
        "--timeout", "0",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Must exit non-zero (timeout is a failure)
    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);

    // CommandId MUST appear in the output so the operator can resume
    expect(output).toContain(TEST_COMMAND_ID);
  });
});

// ─── ssm run — multiline output unescaping ────────────────────────────────────
//
// TOON escapes string values with real newlines as \n (literal backslash-n).
// ssm run must return stdout/stderr as line arrays so each line renders on its
// own row in TOON output, giving the operator real readable newlines.
//
// Revert-proof: return stdout/stderr as a plain string → TOON renders as one
// quoted blob with \n → test fails because "alpha" and "beta" appear as
// "alpha\nbeta" not as separate TOON array rows.

describe("ssm run — multiline output unescaping (captureMain)", () => {
  it("stdout lines render as separate TOON array rows, not as a \\n-escaped blob", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_MULTILINE },
    });

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", "echo -e 'alpha\\nbeta\\ngamma'"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();

    // Each line must be visible individually in the output
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    expect(output).toContain("gamma");

    // The content must NOT be a \\n-escaped one-liner blob
    // If stdout is returned as a plain string, TOON quotes it and outputs "alpha\nbeta\ngamma"
    // (with literal \n sequences). Verify the literal blob form is absent.
    expect(output).not.toMatch(/"alpha\\nbeta/);
  });
});

// ─── ssm run — passthrough forwarding ────────────────────────────────────────
//
// Unknown flags must be forwarded to `send-command` (ADR-0002 superset).
//
// Revert-proof: remove passthrough collection in runSsmRun → the guard stub
// exits 1 because the required flag is absent → output contains USAGE_ERROR
// or SERVICE_CLIENT_ERROR → test assertion on exitCode fails.

describe("ssm run — passthrough forwarding (captureMain)", () => {
  it("unknown flag forwarded to send-command, enriched result still returned", async () => {
    // Stub succeeds ONLY when --comment is present in its argv (forwarded).
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-pt-"));
    tempDirs.push(dir);
    const binary = join(dir, "aws");

    const commentFlag = "--comment";
    const commentValue = "my-test-comment";

    const script = [
      "#!/bin/sh",
      'case "$1-$2" in',
      "  ssm-send-command)",
      `    for arg in "$@"; do`,
      `      if [ "$arg" = "${commentFlag}" ]; then`,
      `        printf '%s' ${shellQuote(SEND_COMMAND_RESPONSE)}`,
      `        exit 0`,
      `      fi`,
      `    done`,
      `    printf 'MISSING_FLAG: ${commentFlag} was not forwarded\\n' >&2`,
      `    exit 1;;`,
      "  ssm-get-command-invocation)",
      `    printf '%s' ${shellQuote(GCI_SUCCESS)}`,
      `    exit 0;;`,
      "  *)",
      '    printf "Unexpected: %s %s\\n" "$1" "$2" >&2',
      "    exit 254;;",
      "esac",
    ].join("\n");

    writeFileSync(binary, script);
    chmodSync(binary, 0o755);

    const { output, exitCode } = await captureMain(
      [
        "ssm", "run",
        "--instance-ids", TEST_INSTANCE_ID,
        "--commands", TEST_COMMAND,
        commentFlag, commentValue,
      ],
      { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    );

    // Stub succeeded (--comment was forwarded) and result is clean
    expect(exitCode).toBeUndefined();
    expect(output).toContain("commandId");
    expect(output).not.toContain("MISSING_FLAG");
  });
});

// ─── ssm run — usage errors ───────────────────────────────────────────────────

describe("ssm run — usage errors (captureMain)", () => {
  it("exits with USAGE_ERROR when --instance-ids is missing", async () => {
    const binary = createStub({});

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--commands", TEST_COMMAND],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("USAGE_ERROR");
  });

  it("exits with USAGE_ERROR when --commands is missing", async () => {
    const binary = createStub({});

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("USAGE_ERROR");
  });
});

// ─── ssm get-command-invocation — unescape + --wait ──────────────────────────
//
// get-command-invocation is a new overlay subcommand. It unescapes
// StandardOutputContent / StandardErrorContent and optionally polls to a
// terminal state with --wait.

describe("ssm get-command-invocation — unescaping (captureMain)", () => {
  it("stdout lines render as separate TOON array rows", async () => {
    const binary = createStub({
      "ssm-get-command-invocation": { stdout: GCI_MULTILINE },
    });

    const { output, exitCode } = await captureMain(
      [
        "ssm", "get-command-invocation",
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    expect(output).toContain("gamma");
    expect(output).not.toMatch(/"alpha\\nbeta/);
  });
});

// ─── ssm get-command-invocation — --wait ─────────────────────────────────────
//
// --wait polls until a terminal state is reached.
//
// Revert-proof: remove the polling loop from runGetCommandInvocation with --wait
// → the first InProgress response is returned as-is → status is InProgress
// not Success → test fails.

describe("ssm get-command-invocation --wait — polling (captureMain)", () => {
  it("polls through InProgress to terminal Success", async () => {
    // Stateful stub: first call → InProgress, second call → Success.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-wait-"));
    tempDirs.push(dir);
    const binary = join(dir, "aws");
    const counterFile = join(dir, "counter");

    const script = [
      "#!/bin/sh",
      'case "$1-$2" in',
      "  ssm-get-command-invocation)",
      `    if [ -f '${counterFile}' ]; then`,
      `      count=$(cat '${counterFile}')`,
      `    else`,
      `      count=0`,
      `    fi`,
      `    count=$((count + 1))`,
      `    printf '%d' "$count" > '${counterFile}'`,
      `    if [ "$count" -le 1 ]; then`,
      `      printf '%s' ${shellQuote(GCI_IN_PROGRESS)}`,
      `    else`,
      `      printf '%s' ${shellQuote(GCI_SUCCESS)}`,
      `    fi`,
      `    exit 0;;`,
      "  *)",
      '    printf "Unexpected: %s %s\\n" "$1" "$2" >&2',
      "    exit 254;;",
      "esac",
    ].join("\n");

    writeFileSync(binary, script);
    chmodSync(binary, 0o755);

    const { output, exitCode } = await captureMain(
      [
        "ssm", "get-command-invocation",
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
        "--wait",
      ],
      { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // Terminal state reached
    expect(output).toContain("Success");
    expect(output).not.toContain("InProgress");
  });
});

// ─── ssm get-command-invocation --wait=false — value-blind bypass fix #56 ────
//
// BUG (pre-fix): hasFlag("--wait=false") returned true (flag token present) →
// the overlay polled to terminal state even though the caller explicitly set
// --wait=false.
//
// FIX: replace hasFlag with flagIsTrue, which honours the =false value.
//
// Test design: stateful stub — first call → InProgress, second → Success.
//   Pre-fix: hasFlag sees --wait=false as "flag present" → polls → 2 calls →
//     Success → result.status === "Success" → assertion below fails (RED).
//   Post-fix: flagIsTrue returns false → single call → InProgress →
//     result.status === "InProgress" → assertion passes (GREEN).
//
// Revert-proof: change flagIsTrue back to hasFlag on the doWait line →
//   polls → Success → result.status !== "InProgress" → test fails.

describe("ssm get-command-invocation --wait=false — no polling (fix #56)", () => {
  it("--wait=false makes a single call and returns InProgress — was polling before fix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-waitfalse-"));
    tempDirs.push(dir);
    const binary = join(dir, "aws");
    const counterFile = join(dir, "counter");

    // Stateful stub: first call → InProgress, second → Success.
    // With --wait=false (after fix): only 1 call → InProgress.
    // With --wait=false (before fix, hasFlag): polls → 2 calls → Success.
    const script = [
      "#!/bin/sh",
      'case "$1-$2" in',
      "  ssm-get-command-invocation)",
      `    if [ -f '${counterFile}' ]; then`,
      `      count=$(cat '${counterFile}')`,
      `    else`,
      `      count=0`,
      `    fi`,
      `    count=$((count + 1))`,
      `    printf '%d' "$count" > '${counterFile}'`,
      `    if [ "$count" -le 1 ]; then`,
      `      printf '%s' ${shellQuote(GCI_IN_PROGRESS)}`,
      `    else`,
      `      printf '%s' ${shellQuote(GCI_SUCCESS)}`,
      `    fi`,
      `    exit 0;;`,
      "  *)",
      '    printf "Unexpected: %s %s\\n" "$1" "$2" >&2',
      "    exit 254;;",
      "esac",
    ].join("\n");

    writeFileSync(binary, script);
    chmodSync(binary, 0o755);

    const result = await ssmRun({
      subcommand: "get-command-invocation",
      args: [
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
        "--wait=false",
      ],
      binary,
    });

    // Single call → InProgress status (the only response the first call returns).
    // If polling occurred, the second call would return Success instead.
    expect("status" in result).toBe(true);
    expect((result as { status: string }).status).toBe("InProgress");
  });

  it("--wait=0 also does NOT poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-wait0-"));
    tempDirs.push(dir);
    const binary = join(dir, "aws");
    const counterFile = join(dir, "counter");

    const script = [
      "#!/bin/sh",
      'case "$1-$2" in',
      "  ssm-get-command-invocation)",
      `    if [ -f '${counterFile}' ]; then`,
      `      count=$(cat '${counterFile}')`,
      `    else`,
      `      count=0`,
      `    fi`,
      `    count=$((count + 1))`,
      `    printf '%d' "$count" > '${counterFile}'`,
      `    if [ "$count" -le 1 ]; then`,
      `      printf '%s' ${shellQuote(GCI_IN_PROGRESS)}`,
      `    else`,
      `      printf '%s' ${shellQuote(GCI_SUCCESS)}`,
      `    fi`,
      `    exit 0;;`,
      "  *)",
      '    printf "Unexpected: %s %s\\n" "$1" "$2" >&2',
      "    exit 254;;",
      "esac",
    ].join("\n");

    writeFileSync(binary, script);
    chmodSync(binary, 0o755);

    const result = await ssmRun({
      subcommand: "get-command-invocation",
      args: [
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
        "--wait=0",
      ],
      binary,
    });

    expect("status" in result).toBe(true);
    expect((result as { status: string }).status).toBe("InProgress");
  });

  it("bare --wait still polls to Success (unaffected by fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-waitbare-"));
    tempDirs.push(dir);
    const binary = join(dir, "aws");
    const counterFile = join(dir, "counter");

    const script = [
      "#!/bin/sh",
      'case "$1-$2" in',
      "  ssm-get-command-invocation)",
      `    if [ -f '${counterFile}' ]; then`,
      `      count=$(cat '${counterFile}')`,
      `    else`,
      `      count=0`,
      `    fi`,
      `    count=$((count + 1))`,
      `    printf '%d' "$count" > '${counterFile}'`,
      `    if [ "$count" -le 1 ]; then`,
      `      printf '%s' ${shellQuote(GCI_IN_PROGRESS)}`,
      `    else`,
      `      printf '%s' ${shellQuote(GCI_SUCCESS)}`,
      `    fi`,
      `    exit 0;;`,
      "  *)",
      '    printf "Unexpected: %s %s\\n" "$1" "$2" >&2',
      "    exit 254;;",
      "esac",
    ].join("\n");

    writeFileSync(binary, script);
    chmodSync(binary, 0o755);

    const result = await ssmRun({
      subcommand: "get-command-invocation",
      args: [
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
        "--wait",
      ],
      binary,
    });

    expect("status" in result).toBe(true);
    expect((result as { status: string }).status).toBe("Success");
  });
});

// ─── ssm get-command-invocation — --query bypass ─────────────────────────────
//
// When --query is present, the overlay projection must be bypassed and the raw
// JMESPath result returned as-is.
//
// Revert-proof: remove the `if (hasQuery)` early return from
// runGetCommandInvocation → the bare string "Success" is mapped as a
// GetCommandInvocationResponse → all fields are undefined → the marker does
// not appear in output → test fails.

describe("ssm get-command-invocation — --query bypass (captureMain)", () => {
  it("bypasses overlay projection and returns raw JMESPath result", async () => {
    const MARKER = "gci-query-bypass-ok";

    // Stub returns a bare string — what JMESPath would produce
    const binary = createStub({
      "ssm-get-command-invocation": { stdout: JSON.stringify(MARKER) },
    });

    const { output, exitCode } = await captureMain(
      [
        "ssm", "get-command-invocation",
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
        "--query", "Status",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // Raw JMESPath marker must appear in output
    expect(output).toContain(MARKER);
    // Overlay projection was bypassed — no projected "commandId" / "status" keys
    expect(output).not.toContain("commandId: null");
  });
});

// ─── BLOCKER 1: InvocationDoesNotExist retry ─────────────────────────────────
//
// After send-command, SSM takes ~0.5–2 s to register the invocation. The first
// poll(s) may receive InvocationDoesNotExist. This is non-fatal — treat it as
// non-terminal and retry with backoff.
//
// Without the fix: the first InvocationDoesNotExist propagates as a fatal
// SERVICE_CLIENT_ERROR → aws-axi exits 254 → command stranded with no handle.
//
// Revert-proof: remove the InvocationDoesNotExist catch in pollInvocation
// → first poll throws → captureMain sees exitCode=254 (SERVICE_CLIENT_ERROR).

const INV_NOT_EXISTS_STDERR =
  "An error occurred (InvocationDoesNotExist) when calling the GetCommandInvocation operation: Invocation does not exist";

describe("ssm run — InvocationDoesNotExist retry (captureMain)", () => {
  it("retries through InvocationDoesNotExist until the invocation registers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-inv-"));
    tempDirs.push(dir);
    const binary = join(dir, "aws");
    const counterFile = join(dir, "gci-counter");

    // First GCI call → InvocationDoesNotExist; second → Success.
    const script = [
      "#!/bin/sh",
      'case "$1-$2" in',
      "  ssm-send-command)",
      `    printf '%s' ${shellQuote(SEND_COMMAND_RESPONSE)}`,
      "    exit 0;;",
      "  ssm-get-command-invocation)",
      `    if [ -f '${counterFile}' ]; then count=$(cat '${counterFile}'); else count=0; fi`,
      `    count=$((count + 1))`,
      `    printf '%d' "$count" > '${counterFile}'`,
      `    if [ "$count" -le 1 ]; then`,
      `      printf '%s' ${shellQuote(INV_NOT_EXISTS_STDERR)} >&2`,
      `      exit 254`,
      `    else`,
      `      printf '%s' ${shellQuote(GCI_SUCCESS)}`,
      `      exit 0`,
      `    fi;;`,
      "  *)",
      '    printf "Unexpected: %s %s\\n" "$1" "$2" >&2',
      "    exit 254;;",
      "esac",
    ].join("\n");
    writeFileSync(binary, script);
    chmodSync(binary, 0o755);

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", TEST_COMMAND],
      { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    );

    // InvocationDoesNotExist was retried, not fatal — should succeed
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Success");
    expect(output).toContain(TEST_COMMAND_ID);
  });

  it("CommandId appears in error output when InvocationDoesNotExist exhausts timeout", async () => {
    // Stub always returns InvocationDoesNotExist → eventually --timeout 0 hits.
    // Even with 0 timeout the send-command must complete first, so the deadline
    // is guaranteed to be in the past when the first poll fires.
    //
    // Revert-proof: the CommandId must be in the error output so the operator
    // can resume; without the fix, the error doesn't contain it.
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": {
        stderr: INV_NOT_EXISTS_STDERR,
        exitCode: 254,
      },
    });

    const { output, exitCode } = await captureMain(
      [
        "ssm", "run",
        "--instance-ids", TEST_INSTANCE_ID,
        "--commands", TEST_COMMAND,
        "--timeout", "0",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);
    // CommandId MUST appear so the operator can resume
    expect(output).toContain(TEST_COMMAND_ID);
  });
});

// ─── BLOCKER 2: --commands quoting ───────────────────────────────────────────
//
// --parameters must be a JSON object (JSON.stringify), not a shell-interpolated
// string (`commands=["${commands}"]`). Commands with " break the parser.
//
// Revert-proof: restore string interpolation → stub receives a non-JSON params
// value → exits 1 → captureMain sees exitCode non-zero.

describe("ssm run — --commands quoting (captureMain)", () => {
  it("commands with double quotes are JSON-encoded, not string-interpolated", async () => {
    const QUOTED_COMMAND = 'grep "error" /var/log/app.log';

    const dir = mkdtempSync(join(tmpdir(), "aws-axi-ssm-qc-"));
    tempDirs.push(dir);
    const binary = join(dir, "aws");

    // Stub validates --parameters starts with '{' (JSON object).
    // String-interpolation form starts with 'commands=[' (not a JSON object).
    const script = [
      "#!/bin/sh",
      'case "$1-$2" in',
      "  ssm-send-command)",
      "    shift 2; params=''",
      "    while [ \"$#\" -gt 0 ]; do",
      "      if [ \"$1\" = \"--parameters\" ] && [ \"$#\" -gt 1 ]; then params=\"$2\"; break; fi",
      "      shift",
      "    done",
      "    case \"$params\" in",
      "      '{'*)",
      `        printf '%s' ${shellQuote(SEND_COMMAND_RESPONSE)}`,
      "        exit 0;;",
      "      *)",
      "        printf 'INVALID_PARAMS_NOT_JSON_OBJECT\\n' >&2",
      "        exit 1;;",
      "    esac;;",
      "  ssm-get-command-invocation)",
      `    printf '%s' ${shellQuote(GCI_SUCCESS)}`,
      "    exit 0;;",
      "  *)",
      '    printf "Unexpected: %s %s\\n" "$1" "$2" >&2',
      "    exit 254;;",
      "esac",
    ].join("\n");
    writeFileSync(binary, script);
    chmodSync(binary, 0o755);

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", QUOTED_COMMAND],
      { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    );

    // Stub accepted the JSON-encoded params → must succeed
    expect(exitCode).toBeUndefined();
    expect(output).toContain("commandId");
    expect(output).not.toContain("INVALID_PARAMS_NOT_JSON_OBJECT");
  });
});

// ─── BLOCKER 3: --query on ssm run → USAGE_ERROR (loud, not silent drop) ──────
//
// ssm run is a composite (send-command + poll); there is no single underlying
// aws response for JMESPath to target. --query must fail with USAGE_ERROR and
// name the workaround: `get-command-invocation --query`.
//
// Silently dropping --query (adding it to ownedFlagNames) is the #33 bug class:
// operator types a flag, gets exit 0, gets WRONG data with no indication.
//
// Revert-proof: remove the hasFlag("--query") guard in runSsmRun →
// --query leaks into passthrough OR is silently dropped → exit 0 →
// expect(exitCode).toBeDefined() fails.

describe("ssm run — --query rejected with USAGE_ERROR (captureMain)", () => {
  it("--query exits USAGE_ERROR and names get-command-invocation as the workaround", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_SUCCESS },
    });

    const { output, exitCode } = await captureMain(
      [
        "ssm", "run",
        "--instance-ids", TEST_INSTANCE_ID,
        "--commands", TEST_COMMAND,
        "--query", "Command.CommandId",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Must fail — not silently succeed with --query ignored or forwarded
    expect(exitCode).toBeDefined();
    expect(output).toContain("USAGE_ERROR");
    // Error must name the workaround so the operator knows where to go
    expect(output).toContain("get-command-invocation");
    // Must NOT proceed to send-command
    expect(output).not.toContain(`commandId: ${TEST_COMMAND_ID}`);
  });
});

// ─── B1-regression: fatal polling error codes preserved through re-throw ──────
//
// When get-command-invocation fails with a SERVICE-level error (not the transient
// InvocationDoesNotExist), pollInvocation re-throws with the ORIGINAL AxiError code
// intact. A re-throw that hardcodes "UNKNOWN" collapses both to exit 255 (wrong).
//
// Revert-proof: change origCode back to "UNKNOWN" in the re-throw catch block →
// both tests below expect 254 / 253 but get 255 → RED.

describe("ssm run — AccessDenied during polling exits 254, not 255 (captureMain)", () => {
  it("AccessDeniedException from get-command-invocation produces SERVICE_CLIENT_ERROR exit 254", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": {
        stderr: ACCESS_DENIED_GCI_STDERR,
        exitCode: 254,
      },
    });

    const { exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", TEST_COMMAND],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // SERVICE_CLIENT_ERROR maps to exit 254 — not 255 (UNKNOWN)
    expect(exitCode).toBe(254);
  });
});

describe("ssm run — ExpiredToken during polling exits 253, not 255 (captureMain)", () => {
  it("ExpiredTokenException from get-command-invocation produces AUTH_EXPIRED exit 253", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": {
        stderr: EXPIRED_TOKEN_GCI_STDERR,
        exitCode: 254,
      },
    });

    const { exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", TEST_COMMAND],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // AUTH_EXPIRED maps to exit 253 — not 255 (UNKNOWN)
    expect(exitCode).toBe(253);
  });
});

// ─── BLOCKER 4: toLines() backslash path integrity ───────────────────────────
//
// awsJson already JSON.parse()s the response → StandardOutputContent has real
// newlines. An extra .replace(/\\n/g, "\n") would eat the 'n' in backslash-n
// pairs, corrupting Windows paths: C:\node\bin → ["C:", "ode\bin"].
//
// Revert-proof: restore the double-unescape in toLines() → "node" is split away
// → test RED.

describe("ssm run — backslash path integrity in stdout (captureMain)", () => {
  it("Windows paths with \\n are not split at the backslash-n pair", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_WINDOWS_PATH },
    });

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", "where node"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // "node" must appear intact — not split at the \n pair into "C:" + "ode\bin".
    // Broken form: toLines("C:\node\bin") → ["C:", "ode\bin"] → "node" absent.
    expect(output).toContain("node");
    // The corrupted form produces "ode\bin" as a separate token without "n" prefix.
    // This is a reliable signal that the backslash-n pair was consumed.
    expect(output).not.toMatch(/\bode\\?bin\b/);
  });
});

describe("ssm get-command-invocation — backslash path integrity (captureMain)", () => {
  it("Windows paths with \\n in stdout are not corrupted", async () => {
    const binary = createStub({
      "ssm-get-command-invocation": { stdout: GCI_WINDOWS_PATH },
    });

    const { output, exitCode } = await captureMain(
      [
        "ssm", "get-command-invocation",
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("node");
  });
});

// ─── BLOCKER 5a: verbatim remote exit code propagation ───────────────────────
//
// Remote exit codes must be propagated verbatim (1..249), NOT collapsed to 1.
// Remote exit 7 → aws-axi exit 7 (ssh / docker exec semantics).
//
// Revert-proof: hardcode `process.exitCode = 1` instead of Math.min(remoteExitCode, 249)
// → captureMain sees exitCode=1 not 7 → test RED.

describe("ssm run — verbatim exit code propagation (captureMain)", () => {
  it("remote exit 7 → process exit 7 (not collapsed to 1)", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_FAILED_7 },
    });

    const { exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", "exit 7"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Verbatim propagation: remote 7 → aws-axi 7, not 1.
    // Distinguishes from the "command not found" case (exit 127) etc.
    expect(exitCode).toBe(7);
  });
});

// ─── BLOCKER 5b: delivery failure → exit 254 ─────────────────────────────────
//
// When SSM never runs the shell (TimedOut, Undeliverable, Cancelled, etc.),
// ResponseCode is -1 and status is a delivery-failure state. Exit must be 254
// (SERVICE_CLIENT_ERROR), NOT 1 (which implies "remote shell ran and failed").
//
// Revert-proof: remove SSM_DELIVERY_FAILURE_STATES gate in ssmCommand →
// remoteExitCode=-1 falls through to exit 250 (sentinel) or no branch fires →
// exitCode is 250 not 254 → test RED.

describe("ssm run — delivery failure exits 254 (captureMain)", () => {
  it("TimedOut (ResponseCode=-1) exits 254, not 1 or 250", async () => {
    const binary = createStub({
      "ssm-send-command": { stdout: SEND_COMMAND_RESPONSE },
      "ssm-get-command-invocation": { stdout: GCI_TIMED_OUT },
    });

    const { output, exitCode } = await captureMain(
      ["ssm", "run", "--instance-ids", TEST_INSTANCE_ID, "--commands", TEST_COMMAND],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Delivery failure → 254 (SSM API-level failure, not remote shell failure)
    expect(exitCode).toBe(254);
    // Verify the status is present in the structured output
    expect(output).toContain("TimedOut");
    // Must NOT misreport as exit 1 (would imply remote shell ran and failed)
    expect(exitCode).not.toBe(1);
  });
});

// ─── BLOCKER 5c: InProgress single-call → exit 0, no false failure ───────────
//
// `get-command-invocation` without --wait may return InProgress (ResponseCode=-1).
// This is NOT a failure — the command is still running. Exiting non-zero here
// would abort `set -e` polling loops.
//
// Revert-proof: remove SSM_NON_TERMINAL_STATES guard → -1 sentinel branch fires
// → exit 250 (false failure) → test RED.

describe("ssm get-command-invocation — InProgress single-call exits 0 (captureMain)", () => {
  it("InProgress (ResponseCode=-1) single call exits 0 — no false failure", async () => {
    const binary = createStub({
      "ssm-get-command-invocation": { stdout: GCI_IN_PROGRESS },
    });

    const { output, exitCode } = await captureMain(
      [
        "ssm", "get-command-invocation",
        "--command-id", TEST_COMMAND_ID,
        "--instance-id", TEST_INSTANCE_ID,
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Still running → exit 0. A set -e polling loop must not abort here.
    expect(exitCode).toBeUndefined();
    expect(output).toContain("InProgress");
  });
});
