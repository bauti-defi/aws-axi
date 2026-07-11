/**
 * Lambda overlay tests — list-functions (read+enrichment), get-function,
 * get-function-configuration, invoke.
 *
 * All tests run against REAL subprocess stubs — no mock clients at the
 * exec-seam boundary. Each stub is written to a unique tmpdir so the
 * module-level caches inside resolve-* primitives never cross-contaminate
 * test cases (cache keys include the binary path).
 *
 * Stub dispatch model (case on $2 = the Lambda sub-operation):
 *   list-functions  → curated multi-function JSON, optional NextToken
 *   get-function    → single function JSON (Code + Configuration)
 *   get-function-configuration → Configuration only
 *   invoke          → metadata on stdout, payload written to outfile (last
 *                     arg before --output)
 *   describe-security-groups / describe-subnets / kms list-aliases /
 *   kms describe-key / logs describe-log-groups / iam get-role  → enrichment
 *   stubs returned by the same binary via $1 (service) + $2 (operation)
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AxiError } from "axi-sdk-js";
import { lambdaRun, lambdaCommand } from "../src/commands/lambda.js";

// ─── Shared fixture data ──────────────────────────────────────────────────────

const ACCOUNT = "123456789012";
const REGION = "us-east-1";

const FN_NAME = "my-function";
const FN_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN_NAME}`;
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/lambda-execution-role`;
const SG_ID = "sg-0a1b2c3d4e5f67890";
const SUBNET_ID = "subnet-0a1b2c3d4e5f67890";
const VPC_ID = "vpc-0a1b2c3d4e5f67890";
const KMS_KEY_ID = "1234abcd-12ab-34cd-56ef-1234567890ab";
const KMS_KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT}:key/${KMS_KEY_ID}`;
const LOG_GROUP = `/aws/lambda/${FN_NAME}`;

// Raw Lambda function shape shared across tests
const FUNCTION_RECORD = {
  FunctionName: FN_NAME,
  FunctionArn: FN_ARN,
  Runtime: "nodejs18.x",
  Role: ROLE_ARN,
  Handler: "index.handler",
  CodeSize: 2048,
  Description: "Test function",
  Timeout: 15,
  MemorySize: 128,
  LastModified: "2024-01-15T10:00:00.000+0000",
  CodeSha256: "abc123def456",
  Version: "$LATEST",
  VpcConfig: {
    SubnetIds: [SUBNET_ID],
    SecurityGroupIds: [SG_ID],
    VpcId: VPC_ID,
  },
  KMSKeyArn: KMS_KEY_ARN,
  TracingConfig: { Mode: "PassThrough" },
  PackageType: "Zip",
  Architectures: ["x86_64"],
  EphemeralStorage: { Size: 512 },
  LoggingConfig: {
    LogFormat: "Text",
    LogGroup: LOG_GROUP,
  },
  State: "Active",
  LastUpdateStatus: "Successful",
};

const FUNCTION_2 = {
  FunctionName: "other-function",
  FunctionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:other-function`,
  Runtime: "python3.12",
  Role: ROLE_ARN,
  Handler: "handler.main",
  CodeSize: 1024,
  Description: "",
  Timeout: 30,
  MemorySize: 256,
  LastModified: "2024-02-01T00:00:00.000+0000",
  CodeSha256: "xyz789",
  Version: "$LATEST",
  State: "Active",
  LastUpdateStatus: "Successful",
};

// list-functions responses
const LIST_FUNCTIONS_TWO = JSON.stringify({ Functions: [FUNCTION_RECORD, FUNCTION_2] });
const LIST_FUNCTIONS_TRUNCATED = JSON.stringify({
  Functions: [FUNCTION_RECORD],
  NextToken: "AQICAHiGqSomePaginationToken==",
});
const LIST_FUNCTIONS_EMPTY = JSON.stringify({ Functions: [] });

// get-function response (includes Code block)
const GET_FUNCTION_RESPONSE = JSON.stringify({
  Configuration: FUNCTION_RECORD,
  Code: {
    RepositoryType: "S3",
    Location: "https://s3.amazonaws.com/bucket/code.zip",
  },
  Tags: {},
});

// get-function-configuration response (Configuration only)
const GET_FUNCTION_CONFIGURATION_RESPONSE = JSON.stringify(FUNCTION_RECORD);

// Enrichment stubs
const SG_RESPONSE = JSON.stringify({
  SecurityGroups: [
    {
      GroupId: SG_ID,
      GroupName: "prod-web-sg",
      Description: "Allow HTTPS inbound",
      VpcId: VPC_ID,
      IpPermissions: [],
      IpPermissionsEgress: [],
    },
  ],
});

const SUBNET_RESPONSE = JSON.stringify({
  Subnets: [
    {
      SubnetId: SUBNET_ID,
      VpcId: VPC_ID,
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
      AvailableIpAddressCount: 250,
      MapPublicIpOnLaunch: false,
      State: "available",
      Tags: [{ Key: "Name", Value: "prod-subnet-a" }],
    },
  ],
});

const KMS_LIST_ALIASES = JSON.stringify({
  Aliases: [
    {
      AliasName: "alias/my-lambda-key",
      AliasArn: `arn:aws:kms:${REGION}:${ACCOUNT}:alias/my-lambda-key`,
      TargetKeyId: KMS_KEY_ID,
      CreationDate: "2024-01-01T00:00:00+00:00",
      LastUpdatedDate: "2024-01-01T00:00:00+00:00",
    },
  ],
});

const KMS_DESCRIBE_KEY = JSON.stringify({
  KeyMetadata: {
    KeyId: KMS_KEY_ID,
    Arn: KMS_KEY_ARN,
    Enabled: true,
    Description: "Lambda encryption key",
    KeyUsage: "ENCRYPT_DECRYPT",
    KeyState: "Enabled",
    Origin: "AWS_KMS",
    KeyManager: "CUSTOMER",
    KeySpec: "SYMMETRIC_DEFAULT",
  },
});

const LOG_GROUP_RESPONSE = JSON.stringify({
  logGroups: [
    {
      logGroupName: LOG_GROUP,
      arn: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${LOG_GROUP}:*`,
      storedBytes: 1024,
      retentionInDays: 14,
      creationTime: 1705320000000,
    },
  ],
});

// invoke payloads
const INVOKE_METADATA_OK = JSON.stringify({
  StatusCode: 200,
  ExecutedVersion: "$LATEST",
});
const INVOKE_PAYLOAD_OK = JSON.stringify({ message: "hello from lambda" });

const INVOKE_METADATA_ERROR = JSON.stringify({
  StatusCode: 200,
  FunctionError: "Unhandled",
  ExecutedVersion: "$LATEST",
});
const INVOKE_PAYLOAD_ERROR = JSON.stringify({
  errorMessage: "TypeError: Cannot read properties of undefined",
  errorType: "TypeError",
});

// ─── Stub factory ─────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * LambdaStubSpec controls what each service+operation returns.
 * The stub dispatches on $1 (service) then $2 (operation).
 */
interface LambdaStubSpec {
  // Lambda operations
  readonly listFunctions?: string;
  readonly getFunction?: string;
  readonly getFunctionConfiguration?: string;
  /** invoke: metadata written to stdout, payload written to the outfile */
  readonly invokeMetadata?: string;
  readonly invokePayload?: string;
  readonly invokeFunctionError?: string; // sets FunctionError in metadata
  // Enrichment stubs (EC2, KMS, Logs, IAM)
  readonly describeSecurityGroups?: string;
  readonly describeSubnets?: string;
  readonly kmsListAliases?: string;
  readonly kmsDescribeKey?: string;
  readonly logsDescribeLogGroups?: string;
  // Error overrides
  readonly listFunctionsExitCode?: number;
  readonly listFunctionsStderr?: string;
}

function createLambdaStub(spec: LambdaStubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-lambda-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "aws");

  const lines: string[] = ["#!/bin/sh", 'case "$1" in'];

  // ── lambda service ──────────────────────────────────────────────────────
  lines.push("  lambda)");
  lines.push('    case "$2" in');

  if (spec.listFunctions !== undefined || spec.listFunctionsStderr !== undefined) {
    const exitCode = spec.listFunctionsExitCode ?? 0;
    lines.push("      list-functions)");
    if (spec.listFunctionsStderr !== undefined) {
      lines.push(`        printf '%s' ${shellQuote(spec.listFunctionsStderr)} >&2`);
      lines.push(`        exit ${exitCode};;`);
    } else {
      lines.push(`        printf '%s' ${shellQuote(spec.listFunctions ?? "")}`,
        `        exit ${exitCode};;`);
    }
  }

  if (spec.getFunction !== undefined) {
    lines.push(
      "      get-function)",
      `        printf '%s' ${shellQuote(spec.getFunction)}`,
      "        exit 0;;",
    );
  }

  if (spec.getFunctionConfiguration !== undefined) {
    lines.push(
      "      get-function-configuration)",
      `        printf '%s' ${shellQuote(spec.getFunctionConfiguration)}`,
      "        exit 0;;",
    );
  }

  if (spec.invokeMetadata !== undefined || spec.invokePayload !== undefined) {
    const metadata = spec.invokeMetadata ?? INVOKE_METADATA_OK;
    const payload = spec.invokePayload ?? INVOKE_PAYLOAD_OK;
    // The outfile is the arg that immediately precedes the final "--output" arg.
    // Our implementation arranges args as: lambda invoke [flags...] <outfile> --output json
    // So we find the arg before "--output" to write the payload.
    lines.push(
      "      invoke)",
      // Walk $@ to find the arg before --output
      "        prev=''",
      "        outfile=''",
      "        for arg in \"$@\"; do",
      "          if [ \"$arg\" = \"--output\" ]; then",
      "            outfile=\"$prev\"",
      "            break",
      "          fi",
      "          prev=\"$arg\"",
      "        done",
      `        if [ -n "$outfile" ]; then printf '%s' ${shellQuote(payload)} > "$outfile"; fi`,
      `        printf '%s' ${shellQuote(metadata)}`,
      "        exit 0;;",
    );
  }

  lines.push(
    "      *)",
    '        printf "Unexpected lambda sub-op: %s\\n" "$2" >&2',
    "        exit 254;;",
    "    esac;;",
  );

  // ── ec2 service ────────────────────────────────────────────────────────
  lines.push("  ec2)");
  lines.push('    case "$2" in');

  if (spec.describeSecurityGroups !== undefined) {
    lines.push(
      "      describe-security-groups)",
      `        printf '%s' ${shellQuote(spec.describeSecurityGroups)}`,
      "        exit 0;;",
    );
  }

  if (spec.describeSubnets !== undefined) {
    lines.push(
      "      describe-subnets)",
      `        printf '%s' ${shellQuote(spec.describeSubnets)}`,
      "        exit 0;;",
    );
  }

  lines.push(
    "      *)",
    `        printf '%s' '{"SecurityGroups":[],"Subnets":[]}'`,
    "        exit 0;;",
    "    esac;;",
  );

  // ── kms service ────────────────────────────────────────────────────────
  lines.push("  kms)");
  lines.push('    case "$2" in');

  if (spec.kmsListAliases !== undefined) {
    lines.push(
      "      list-aliases)",
      `        printf '%s' ${shellQuote(spec.kmsListAliases)}`,
      "        exit 0;;",
    );
  }

  if (spec.kmsDescribeKey !== undefined) {
    lines.push(
      "      describe-key)",
      `        printf '%s' ${shellQuote(spec.kmsDescribeKey)}`,
      "        exit 0;;",
    );
  }

  lines.push(
    "      *)",
    `        printf '%s' '{"Aliases":[]}'`,
    "        exit 0;;",
    "    esac;;",
  );

  // ── logs service ───────────────────────────────────────────────────────
  lines.push("  logs)");
  if (spec.logsDescribeLogGroups !== undefined) {
    lines.push(
      `    printf '%s' ${shellQuote(spec.logsDescribeLogGroups)}`,
      "    exit 0;;",
    );
  } else {
    lines.push(`    printf '%s' '{"logGroups":[]}'`, "    exit 0;;");
  }

  // ── iam service ────────────────────────────────────────────────────────
  // role.ts resolves ARNs locally (no network call) so IAM stub rarely needed
  lines.push("  iam)");
  lines.push(`    printf '%s' '{"Role":{"RoleName":"lambda-execution-role","Arn":"${ROLE_ARN}","RoleId":"AROABC","CreateDate":"2024-01-01T00:00:00Z","Path":"/"}}'`);
  lines.push("    exit 0;;");

  lines.push(
    "  *)",
    '    printf "Unexpected service: %s\\n" "$1" >&2',
    "    exit 254;;",
    "esac",
  );

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

// ─── list-functions: happy path ───────────────────────────────────────────────

describe("lambdaRun list-functions — happy path", () => {
  it("returns curated function list for two functions", async () => {
    const stub = createLambdaStub({ listFunctions: LIST_FUNCTIONS_TWO });

    const result = await lambdaRun({
      subcommand: "list-functions",
      args: [],
      binary: stub,
    });

    expect("functions" in result).toBe(true);
    if (!("functions" in result)) throw new Error("wrong discriminant");

    const { functions } = result;
    expect(functions.items).toHaveLength(2);

    const fn1 = functions.items.find((f) => f.name === FN_NAME);
    expect(fn1).toBeDefined();
    expect(fn1?.runtime).toBe("nodejs18.x");
    expect(fn1?.handler).toBe("index.handler");
    expect(fn1?.memoryMb).toBe(128);
    expect(fn1?.timeoutSec).toBe(15);
    expect(fn1?.state).toBe("Active");
  });

  it("count string shows N total when not truncated", async () => {
    const stub = createLambdaStub({ listFunctions: LIST_FUNCTIONS_TWO });
    const result = await lambdaRun({ subcommand: "list-functions", args: [], binary: stub });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    expect(result.functions.count).toContain("2");
    expect(result.functions.count).toContain("total");
    expect(result.functions.nextToken).toBeUndefined();
  });
});

// ─── list-functions: pagination ───────────────────────────────────────────────

describe("lambdaRun list-functions — pagination", () => {
  it("reports truncation honestly on synthesized NextToken — does NOT gate on NextMarker", async () => {
    const stub = createLambdaStub({ listFunctions: LIST_FUNCTIONS_TRUNCATED });
    const result = await lambdaRun({
      subcommand: "list-functions",
      args: ["--max-items", "1"],
      binary: stub,
    });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    expect(result.functions.nextToken).toBe("AQICAHiGqSomePaginationToken==");
    expect(result.functions.count).toContain("truncated");
    expect(result.functions.count).toContain("AQICAHiGqSomePaginationToken==");
  });

  it("passes --max-items to aws cli", async () => {
    // Stub echoes its args so we verify --max-items appears in the call
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-lambda-args-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "aws");
    writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        "  lambda) echo \"$@\" ;;",
        "  *) exit 0;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);

    // Will fail JSON parse; we verify --max-items was forwarded
    try {
      await lambdaRun({
        subcommand: "list-functions",
        args: ["--max-items", "5"],
        binary: scriptPath,
      });
    } catch (e) {
      expect((e as AxiError).message).toContain("--max-items");
    }
  });

  it("accepts --next-token to resume pagination", async () => {
    // Stub returns the truncated list regardless; we just verify no error + token respected
    const stub = createLambdaStub({ listFunctions: LIST_FUNCTIONS_TWO });
    const result = await lambdaRun({
      subcommand: "list-functions",
      args: ["--next-token", "AQICAHiGqSomePaginationToken=="],
      binary: stub,
    });
    if (!("functions" in result)) throw new Error("wrong discriminant");
    expect(result.functions.items).toHaveLength(2);
  });
});

// ─── list-functions: empty state ──────────────────────────────────────────────

describe("lambdaRun list-functions — empty state", () => {
  it("returns a definitive empty state with guidance", async () => {
    const stub = createLambdaStub({ listFunctions: LIST_FUNCTIONS_EMPTY });
    const result = await lambdaRun({ subcommand: "list-functions", args: [], binary: stub });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    expect(result.functions.items).toHaveLength(0);
    expect(result.functions.count).toBe("0 total");
    expect(result.functions.message).toBeTruthy();
  });
});

// ─── list-functions: enrichment ───────────────────────────────────────────────

describe("lambdaRun list-functions — enrichment", () => {
  it("resolves role ARN to name without a network call (parsed from ARN)", async () => {
    const stub = createLambdaStub({
      listFunctions: LIST_FUNCTIONS_TWO,
    });
    const result = await lambdaRun({ subcommand: "list-functions", args: [], binary: stub });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    const fn1 = result.functions.items.find((f) => f.name === FN_NAME);
    // Role name should be extracted from the ARN (last path segment)
    expect(fn1?.role).toBe("lambda-execution-role");
  });

  it("resolves VPC security group ids and subnet ids to human names", async () => {
    const stub = createLambdaStub({
      listFunctions: LIST_FUNCTIONS_TWO,
      describeSecurityGroups: SG_RESPONSE,
      describeSubnets: SUBNET_RESPONSE,
    });
    const result = await lambdaRun({ subcommand: "list-functions", args: [], binary: stub });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    const fn1 = result.functions.items.find((f) => f.name === FN_NAME);
    expect(fn1?.vpc).toBeDefined();
    expect(fn1?.vpc?.securityGroups).toEqual(["prod-web-sg"]);
    expect(fn1?.vpc?.subnets).toEqual(["prod-subnet-a"]);
  });

  it("resolves KMS key ARN to alias name", async () => {
    const stub = createLambdaStub({
      listFunctions: LIST_FUNCTIONS_TWO,
      kmsDescribeKey: KMS_DESCRIBE_KEY,
      kmsListAliases: KMS_LIST_ALIASES,
    });
    const result = await lambdaRun({ subcommand: "list-functions", args: [], binary: stub });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    const fn1 = result.functions.items.find((f) => f.name === FN_NAME);
    expect(fn1?.kmsAlias).toBe("alias/my-lambda-key");
  });

  it("resolves CloudWatch log group from LoggingConfig", async () => {
    const stub = createLambdaStub({
      listFunctions: LIST_FUNCTIONS_TWO,
      logsDescribeLogGroups: LOG_GROUP_RESPONSE,
    });
    const result = await lambdaRun({ subcommand: "list-functions", args: [], binary: stub });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    const fn1 = result.functions.items.find((f) => f.name === FN_NAME);
    // logGroup should be the resolved name (trimmed of ARN noise)
    expect(fn1?.logGroup).toBe(LOG_GROUP);
  });

  it("gracefully degrades enrichment on individual AWS errors (returns raw id / undefined)", async () => {
    // SG and subnet stubs absent → resolveSg/resolveSubnet return null → degrade
    const stub = createLambdaStub({
      listFunctions: LIST_FUNCTIONS_TWO,
      // No SG/subnet enrichment stubs → fall back to error / null
    });
    const result = await lambdaRun({ subcommand: "list-functions", args: [], binary: stub });
    if (!("functions" in result)) throw new Error("wrong discriminant");

    // Must NOT throw even when enrichment fails
    expect(result.functions.items).toHaveLength(2);
    const fn1 = result.functions.items.find((f) => f.name === FN_NAME);
    // VPC ids still present even if names not resolved
    expect(fn1?.vpc).toBeDefined();
  });
});

// ─── get-function ─────────────────────────────────────────────────────────────

describe("lambdaRun get-function — happy path", () => {
  it("returns curated function detail with full enrichment", async () => {
    const stub = createLambdaStub({
      getFunction: GET_FUNCTION_RESPONSE,
      describeSecurityGroups: SG_RESPONSE,
      describeSubnets: SUBNET_RESPONSE,
      kmsDescribeKey: KMS_DESCRIBE_KEY,
      kmsListAliases: KMS_LIST_ALIASES,
      logsDescribeLogGroups: LOG_GROUP_RESPONSE,
    });

    const result = await lambdaRun({
      subcommand: "get-function",
      args: [FN_NAME],
      binary: stub,
    });

    expect("function" in result).toBe(true);
    if (!("function" in result)) throw new Error("wrong discriminant");

    const { function: fn } = result;
    expect(fn.name).toBe(FN_NAME);
    expect(fn.runtime).toBe("nodejs18.x");
    expect(fn.role).toBe("lambda-execution-role");
    expect(fn.vpc?.securityGroups).toEqual(["prod-web-sg"]);
    expect(fn.vpc?.subnets).toEqual(["prod-subnet-a"]);
    expect(fn.kmsAlias).toBe("alias/my-lambda-key");
    expect(fn.logGroup).toBe(LOG_GROUP);
  });

  it("requires a function name", async () => {
    const stub = createLambdaStub({ getFunction: GET_FUNCTION_RESPONSE });
    await expect(
      lambdaRun({ subcommand: "get-function", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

// ─── get-function-configuration ───────────────────────────────────────────────

describe("lambdaRun get-function-configuration — happy path", () => {
  it("returns curated configuration (same fields, no Code block noise)", async () => {
    const stub = createLambdaStub({
      getFunctionConfiguration: GET_FUNCTION_CONFIGURATION_RESPONSE,
      describeSecurityGroups: SG_RESPONSE,
      describeSubnets: SUBNET_RESPONSE,
    });

    const result = await lambdaRun({
      subcommand: "get-function-configuration",
      args: [FN_NAME],
      binary: stub,
    });

    expect("function" in result).toBe(true);
    if (!("function" in result)) throw new Error("wrong discriminant");

    const { function: fn } = result;
    expect(fn.name).toBe(FN_NAME);
    expect(fn.handler).toBe("index.handler");
  });

  it("requires a function name", async () => {
    const stub = createLambdaStub({ getFunctionConfiguration: GET_FUNCTION_CONFIGURATION_RESPONSE });
    await expect(
      lambdaRun({ subcommand: "get-function-configuration", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

// ─── invoke ───────────────────────────────────────────────────────────────────

describe("lambdaRun invoke — success", () => {
  it("returns statusCode 200 and decoded JSON payload", async () => {
    const stub = createLambdaStub({
      invokeMetadata: INVOKE_METADATA_OK,
      invokePayload: INVOKE_PAYLOAD_OK,
    });

    const result = await lambdaRun({
      subcommand: "invoke",
      args: ["--function-name", FN_NAME],
      binary: stub,
    });

    expect("invocation" in result).toBe(true);
    if (!("invocation" in result)) throw new Error("wrong discriminant");

    const { invocation } = result;
    expect(invocation.statusCode).toBe(200);
    expect(invocation.functionError).toBeUndefined();
    expect((invocation.payload as Record<string, unknown>)["message"]).toBe(
      "hello from lambda",
    );
  });

  it("accepts --payload as a JSON string", async () => {
    const stub = createLambdaStub({
      invokeMetadata: INVOKE_METADATA_OK,
      invokePayload: INVOKE_PAYLOAD_OK,
    });
    // Should not throw; payload flag is forwarded to aws
    const result = await lambdaRun({
      subcommand: "invoke",
      args: ["--function-name", FN_NAME, "--payload", '{"key":"value"}'],
      binary: stub,
    });
    if (!("invocation" in result)) throw new Error("wrong discriminant");
    expect(result.invocation.statusCode).toBe(200);
  });
});

describe("lambdaRun invoke — FunctionError", () => {
  it("surfaces FunctionError as a distinct field (not thrown as an AxiError)", async () => {
    const stub = createLambdaStub({
      invokeMetadata: INVOKE_METADATA_ERROR,
      invokePayload: INVOKE_PAYLOAD_ERROR,
    });

    // Must NOT throw — FunctionError is an invocation-level result, not an infra error
    const result = await lambdaRun({
      subcommand: "invoke",
      args: ["--function-name", FN_NAME],
      binary: stub,
    });

    if (!("invocation" in result)) throw new Error("wrong discriminant");
    const { invocation } = result;
    expect(invocation.statusCode).toBe(200);
    expect(invocation.functionError).toBe("Unhandled");
    // Payload is the error detail from the function
    const payload = invocation.payload as Record<string, unknown>;
    expect(payload["errorType"]).toBe("TypeError");
  });
});

describe("lambdaRun invoke — usage errors", () => {
  it("requires --function-name", async () => {
    const stub = createLambdaStub({
      invokeMetadata: INVOKE_METADATA_OK,
      invokePayload: INVOKE_PAYLOAD_OK,
    });
    await expect(
      lambdaRun({ subcommand: "invoke", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

// ─── lambdaRun: unknown subcommand ────────────────────────────────────────────

describe("lambdaRun — unknown subcommand", () => {
  it("throws USAGE_ERROR for unrecognised operations", async () => {
    const stub = createLambdaStub({});
    await expect(
      lambdaRun({ subcommand: "delete-function", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

// ─── lambdaCommand: arg dispatch ──────────────────────────────────────────────

describe("lambdaCommand — CLI arg dispatch", () => {
  it("defaults to list-functions when no subcommand given", async () => {
    const stub = createLambdaStub({ listFunctions: LIST_FUNCTIONS_TWO });
    const result = await lambdaCommand([], undefined, stub);
    expect("lambda" in result).toBe(true);
    const inner = result["lambda"] as Record<string, unknown>;
    expect("functions" in inner).toBe(true);
  });

  it("wraps result under a lambda key", async () => {
    const stub = createLambdaStub({ listFunctions: LIST_FUNCTIONS_TWO });
    const result = await lambdaCommand(["list-functions"], undefined, stub);
    expect(Object.keys(result)).toContain("lambda");
  });

  it("throws USAGE_ERROR for unknown subcommand", async () => {
    const stub = createLambdaStub({});
    await expect(
      lambdaCommand(["delete-function"], undefined, stub),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("dispatches get-function with positional function name", async () => {
    const stub = createLambdaStub({ getFunction: GET_FUNCTION_RESPONSE });
    const result = await lambdaCommand(["get-function", FN_NAME], undefined, stub);
    const inner = result["lambda"] as Record<string, unknown>;
    expect("function" in inner).toBe(true);
  });

  it("dispatches invoke and surfaces invocation result", async () => {
    const stub = createLambdaStub({
      invokeMetadata: INVOKE_METADATA_OK,
      invokePayload: INVOKE_PAYLOAD_OK,
    });
    const result = await lambdaCommand(
      ["invoke", "--function-name", FN_NAME],
      undefined,
      stub,
    );
    const inner = result["lambda"] as Record<string, unknown>;
    expect("invocation" in inner).toBe(true);
  });
});

// ─── invoke: --cli-binary-format correctness (CLI v2 blocker) ─────────────────
//
// AWS CLI v2 default binary format is base64. Passing a raw-JSON --payload
// without --cli-binary-format raw-in-base64-out causes:
//   "Invalid base64: ..." and the invocation fails on real CLI v2.
//
// Fix contract:
//   When --payload is supplied → aws call MUST include
//   --cli-binary-format raw-in-base64-out so the JSON is accepted as-is.
//   When --payload is absent  → flag MUST NOT appear (avoid unnecessary args).
//
// We verify by capturing the actual args received by the aws stub binary.

/**
 * Create a stub binary that, on `lambda invoke`, records all received args
 * to `argsFile` then returns a valid invoke response so the caller succeeds.
 */
function createCapturingInvokeStub(): { binary: string; argsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-lambda-capture-"));
  tempDirs.push(dir);
  const argsFile = join(dir, "captured-args");
  const binary = join(dir, "aws");

  const script = [
    "#!/bin/sh",
    'case "$1" in',
    "  lambda)",
    '    case "$2" in',
    "      invoke)",
    // Record all args (space-separated) to the capture file
    `        echo "$@" > ${shellQuote(argsFile)}`,
    // Find the outfile: arg immediately before "--output" (appended by buildArgs)
    "        prev=''",
    "        outfile=''",
    "        for arg in \"$@\"; do",
    "          if [ \"$arg\" = \"--output\" ]; then outfile=\"$prev\"; break; fi",
    "          prev=\"$arg\"",
    "        done",
    `        if [ -n "$outfile" ]; then printf '%s' ${shellQuote(INVOKE_PAYLOAD_OK)} > "$outfile"; fi`,
    `        printf '%s' ${shellQuote(INVOKE_METADATA_OK)}`,
    "        exit 0;;",
    "    esac;;",
    "esac",
    "exit 0",
  ].join("\n");

  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return { binary, argsFile };
}

describe("lambdaRun invoke — --cli-binary-format raw-in-base64-out (CLI v2)", () => {
  it("includes --cli-binary-format raw-in-base64-out when --payload is supplied", async () => {
    const { binary, argsFile } = createCapturingInvokeStub();

    await lambdaRun({
      subcommand: "invoke",
      args: ["--function-name", FN_NAME, "--payload", '{"key":"value"}'],
      binary,
    });

    const capturedArgs = readFileSync(argsFile, "utf-8");
    expect(capturedArgs).toContain("--cli-binary-format");
    expect(capturedArgs).toContain("raw-in-base64-out");
    // The raw JSON payload must appear as-is (no base64 encoding applied by us)
    expect(capturedArgs).toContain('{"key":"value"}');
  });

  it("does NOT include --cli-binary-format when --payload is absent", async () => {
    const { binary, argsFile } = createCapturingInvokeStub();

    await lambdaRun({
      subcommand: "invoke",
      args: ["--function-name", FN_NAME],
      binary,
    });

    const capturedArgs = readFileSync(argsFile, "utf-8");
    expect(capturedArgs).not.toContain("--cli-binary-format");
  });
});
