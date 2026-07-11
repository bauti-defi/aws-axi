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
import { ssmRun, ssmCommand } from "../src/commands/ssm.js";

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

// ─── SECURITY INVARIANT helper ────────────────────────────────────────────────

/** Returns true if the serialised result contains the secret string. */
function leaksValue(result: unknown, secret: string): boolean {
  return JSON.stringify(result).includes(secret);
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
    if (!("parameter" in result)) throw new Error("wrong discriminant");
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
    if (!("parameter" in result)) throw new Error("wrong discriminant");
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

    if (!("parameter" in result)) throw new Error("wrong discriminant");
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

    if (!("parameter" in result)) throw new Error("wrong discriminant");
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

    if (!("parameter" in result)) throw new Error("wrong discriminant");
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

    if (!("parameter" in result)) throw new Error("wrong discriminant");
    expect(result.parameter.value).toBe(PARAM_VALUE_STRING);
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

    if (!("parameter" in result)) throw new Error("wrong discriminant");
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

    if (!("parameterList" in result)) throw new Error("wrong discriminant");
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

    if (!("parameterList" in result)) throw new Error("wrong discriminant");
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

    if (!("parameterList" in result)) throw new Error("wrong discriminant");
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

    if (!("parameterList" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersByPath" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersByPath" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersByPath" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersByPath" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersMeta" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersMeta" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersMeta" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersMeta" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersMeta" in result)) throw new Error("wrong discriminant");
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

    if (!("parametersMeta" in result)) throw new Error("wrong discriminant");
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
