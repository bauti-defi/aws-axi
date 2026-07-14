/**
 * `aws-axi lambda` — Lambda read + invoke overlay.
 *
 * Mirrors `aws lambda <op>` 1:1 for the three read operations and invoke:
 *   list-functions              — curated list with pagination cap + enrichment
 *   get-function                — curated single-function detail + enrichment
 *   get-function-configuration  — configuration only (no Code block) + enrichment
 *   invoke                      — execute a function; surface status, payload, errors
 *
 * Enrichment (shared resolve-primitives, built once at their root tier):
 *   Role ARN          → role name via resolve-role (ARN-parsed; no network)
 *   VpcConfig SG ids  → group names via resolve-sg
 *   VpcConfig subnets → subnet names via resolve-subnet
 *   LoggingConfig.LogGroup → log group name via resolve-log-group
 *   KMSKeyArn         → alias name via resolve-key
 *
 * Pagination contract (CRITICAL — spec §pagination-cap):
 *   `--max-items <n>` is forwarded to the botocore paginator.
 *   Truncation is gated ONLY on the synthesized `NextToken` that botocore
 *   emits. The native `NextMarker` from the raw Lambda API is NEVER used as
 *   a truncation gate — botocore strips it and replaces it with NextToken.
 *
 * Exports:
 *   lambdaRun(options)          → typed LambdaRunResult (testing / composition)
 *   lambdaCommand(args, ctx, b) → AxiCliCommand adapter (CLI dispatch)
 *   LAMBDA_HELP                 → help text string
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import type { AwsRunOptions } from "../aws.js";
import { awsJson, awsRaw } from "../aws.js";
import { resolveRole } from "../resolve/role.js";
import { resolveSg } from "../resolve/sg.js";
import { resolveSubnet } from "../resolve/subnet.js";
import { resolveLogGroup } from "../resolve/log-group.js";
import { resolveKey } from "../resolve/key.js";
import { fallThroughToEngine } from "../engine.js";
import { collectPassthroughFlags, buildPassthrough } from "../overlay-args.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITEMS_DEFAULT = 25;

const KNOWN_SUBCOMMANDS = new Set([
  "list-functions",
  "get-function",
  "get-function-configuration",
  "invoke",
]);

// ─── Raw AWS response shapes ──────────────────────────────────────────────────

interface RawLambdaVpcConfig {
  readonly SubnetIds?: readonly string[];
  readonly SecurityGroupIds?: readonly string[];
  readonly VpcId?: string;
}

interface RawLambdaLoggingConfig {
  readonly LogFormat?: string;
  readonly LogGroup?: string;
}

interface RawLambdaFunction {
  readonly FunctionName: string;
  readonly FunctionArn: string;
  readonly Runtime?: string;
  readonly Role?: string;
  readonly Handler?: string;
  readonly CodeSize?: number;
  readonly Description?: string;
  readonly Timeout?: number;
  readonly MemorySize?: number;
  readonly LastModified?: string;
  readonly CodeSha256?: string;
  readonly Version?: string;
  readonly VpcConfig?: RawLambdaVpcConfig;
  readonly KMSKeyArn?: string;
  readonly TracingConfig?: { readonly Mode?: string };
  readonly PackageType?: string;
  readonly Architectures?: readonly string[];
  readonly EphemeralStorage?: { readonly Size?: number };
  readonly LoggingConfig?: RawLambdaLoggingConfig;
  readonly State?: string;
  readonly StateReason?: string;
  readonly LastUpdateStatus?: string;
}

interface RawListFunctionsResponse {
  readonly Functions: readonly RawLambdaFunction[];
  /** Synthesized by botocore paginator — gates truncation. */
  readonly NextToken?: string;
}

interface RawGetFunctionResponse {
  readonly Configuration: RawLambdaFunction;
  readonly Code?: {
    readonly RepositoryType?: string;
    readonly Location?: string;
  };
  readonly Tags?: Record<string, string>;
}

interface RawInvokeMetadata {
  readonly StatusCode: number;
  readonly FunctionError?: string;
  readonly ExecutedVersion?: string;
  /** Base64-encoded log tail (only when --log-type Tail). */
  readonly LogResult?: string;
}

// ─── Curated output types ─────────────────────────────────────────────────────

/** Resolved VPC configuration with human-readable names, not raw ids. */
export interface LambdaVpcSummary {
  readonly vpcId: string;
  /** SG ids with best-effort name resolution. Falls back to raw id. */
  readonly securityGroups: readonly string[];
  /** Subnet ids with best-effort name resolution. Falls back to raw id. */
  readonly subnets: readonly string[];
}

export interface LambdaFunctionSummary {
  readonly name: string;
  readonly arn: string;
  readonly runtime: string;
  readonly handler: string;
  readonly memoryMb: number;
  readonly timeoutSec: number;
  readonly lastModified: string;
  readonly state: string;
  /** Resolved role name from ARN (e.g. "lambda-execution-role"). */
  readonly role: string | undefined;
  /** Resolved VPC config with human names. Absent when no VPC attached. */
  readonly vpc: LambdaVpcSummary | undefined;
  /** CloudWatch log group name. Absent when LoggingConfig is not set. */
  readonly logGroup: string | undefined;
  /** Primary KMS alias (e.g. "alias/my-key"). Absent when no KMS key. */
  readonly kmsAlias: string | undefined;
}

export interface LambdaListResult {
  readonly items: readonly LambdaFunctionSummary[];
  /** Human-readable count/pagination summary. */
  readonly count: string;
  /** Present when response was truncated; pass to --next-token to continue. */
  readonly nextToken?: string;
  /** Set on empty result. */
  readonly message?: string;
}

export interface LambdaInvokeResult {
  readonly statusCode: number;
  /** Present when the function itself threw an error (HTTP 200 but bad outcome). */
  readonly functionError?: string;
  /** Decoded response payload (parsed JSON or raw string). */
  readonly payload: unknown;
  /** Decoded log tail (only when --log-type Tail was requested). */
  readonly logTail?: string;
}

/** Discriminated union returned by lambdaRun. Raw Record when --query bypass is active. */
export type LambdaRunResult =
  | { readonly functions: LambdaListResult }
  | { readonly function: LambdaFunctionSummary }
  | { readonly invocation: LambdaInvokeResult }
  | Record<string, unknown>;

export interface LambdaRunOptions {
  readonly subcommand: string;
  /** Remaining args after the subcommand has been extracted. */
  readonly args: readonly string[];
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export const LAMBDA_HELP = `usage: aws-axi lambda <subcommand> [flags]

Any flag accepted by the underlying \`aws lambda\` operation (e.g.
--function-version, --qualifier, --query) is forwarded verbatim — overlays never
restrict the input contract, only enrich the output.

subcommands (enriched overlays):
  list-functions              List Lambda functions (default when omitted)
  get-function <name>         Describe a function including code location
  get-function-configuration <name>  Configuration only (no code URL)
  invoke --function-name <n>  Invoke a function synchronously
  (any other lambda subcommand falls through to the generic engine — run \`aws lambda help\` to list all)

flags (overlay-specific):
  --profile <name>            AWS profile (inherited from global --profile)
  --region <region>           AWS region  (inherited from global --region)
  --query <expr>              JMESPath; bypasses overlay projection, returns raw result.
                              Output is unbounded (botocore auto-pages all results;
                              default cap suppressed). To bound output, pass --max-items N.
  --output                    stripped (aws-axi always uses --output json internally)

flags (list-functions):
  --max-items <n>             Cap results per page (default: ${MAX_ITEMS_DEFAULT})
  --next-token <token>        Resume a previous paginated call

flags (invoke):
  --function-name <name>      Function name or ARN (required)
  --payload <json>            Raw JSON input payload (CLI v2: passes raw-in-base64-out automatically)
  --invocation-type <type>    RequestResponse|Event|DryRun (default: RequestResponse)
  --log-type <type>           None|Tail — Tail returns last 4 KB of logs
  note: --query applies to invocation metadata (StatusCode, ExecutedVersion,
        FunctionError) only — the response payload is not retained. Invoke
        without --query to receive the response payload.

examples:
  aws-axi lambda
  aws-axi lambda list-functions
  aws-axi lambda list-functions --max-items 10
  aws-axi lambda list-functions --next-token AQE...
  aws-axi lambda get-function my-function
  aws-axi lambda get-function my-function --qualifier v1  # forwarded to aws
  aws-axi lambda get-function-configuration my-function
  aws-axi lambda invoke --function-name my-function --payload '{"key":"val"}'
  aws-axi lambda invoke --function-name my-function --log-type Tail
`;

// ─── Arg-parsing helpers ──────────────────────────────────────────────────────

/**
 * Extract the value of a named flag. Accepts both forms:
 *   --flag value     (space-separated)
 *   --flag=value     (equals-separated)
 */
function extractFlag(args: readonly string[], flag: string): string | undefined {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === flag && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith(eqPrefix)) {
      return arg.slice(eqPrefix.length);
    }
  }
  return undefined;
}

function extractMaxItems(args: readonly string[]): number {
  const raw = extractFlag(args, "--max-items");
  if (raw === undefined) return MAX_ITEMS_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new AxiError(
      `--max-items must be a positive integer, got: ${raw}`,
      "USAGE_ERROR",
      [`Run \`aws-axi lambda --help\` to see valid flags`],
    );
  }
  return parsed;
}

/**
 * Extract bare positional arguments (non-flag tokens) from args.
 * Skips both --flag=value (combined) and --flag value (pair) forms.
 */
function extractPositionals(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      // --flag=value form: skip only this combined token
      continue;
    }
    if (arg.startsWith("--")) {
      // --flag value form: skip this token AND the following value token
      i++;
    } else if (arg !== "") {
      result.push(arg);
    }
  }
  return result;
}

/** Build a human-readable count/pagination summary string. */
function countString(n: number, nextToken: string | undefined): string {
  if (nextToken !== undefined) {
    return `showing ${n} (truncated); next-token=${nextToken}`;
  }
  return `${n} total`;
}

function toRunOpts(options: LambdaRunOptions): AwsRunOptions {
  return { binary: options.binary, context: options.context };
}

// ─── Enrichment helpers ───────────────────────────────────────────────────────

/**
 * Enrich a single raw Lambda function record with human-readable names.
 * All enrichment calls are best-effort — errors never propagate (degrade to
 * undefined or raw id). Parallel calls where possible.
 */
async function enrichFunction(
  fn: RawLambdaFunction,
  opts: LambdaRunOptions,
): Promise<LambdaFunctionSummary> {
  const runOpts = toRunOpts(opts);

  // Kick off all resolutions in parallel
  const [resolvedRole, vpcResult, kmsResult, logGroupResult] = await Promise.all([
    // Role: ARN → name (pure parse, no network)
    fn.Role !== undefined
      ? resolveRole({
          nameOrArn: fn.Role,
          binary: opts.binary,
          context: opts.context,
        }).then((r) => r.name).catch(() => undefined)
      : Promise.resolve(undefined),

    // VPC config: SG ids + subnet ids → names in parallel
    fn.VpcConfig !== undefined &&
    (
      (fn.VpcConfig.SecurityGroupIds?.length ?? 0) > 0 ||
      (fn.VpcConfig.SubnetIds?.length ?? 0) > 0
    )
      ? resolveVpcConfig(fn.VpcConfig, runOpts)
      : Promise.resolve(undefined),

    // KMS key ARN → alias
    fn.KMSKeyArn !== undefined
      ? resolveKey(fn.KMSKeyArn, {
          binary: opts.binary,
          context: opts.context,
        }).then((r) => r.alias).catch(() => undefined)
      : Promise.resolve(undefined),

    // Log group name from LoggingConfig
    fn.LoggingConfig?.LogGroup !== undefined
      ? resolveLogGroup(fn.LoggingConfig.LogGroup, {
          binary: opts.binary,
          context: opts.context,
        }).then((r) => r?.name ?? fn.LoggingConfig?.LogGroup).catch(() => fn.LoggingConfig?.LogGroup)
      : Promise.resolve(undefined),
  ]);

  return {
    name: fn.FunctionName,
    arn: fn.FunctionArn,
    runtime: fn.Runtime ?? "unknown",
    handler: fn.Handler ?? "unknown",
    memoryMb: fn.MemorySize ?? 0,
    timeoutSec: fn.Timeout ?? 0,
    lastModified: fn.LastModified ?? "",
    state: fn.State ?? "unknown",
    role: resolvedRole,
    vpc: vpcResult,
    logGroup: logGroupResult,
    kmsAlias: kmsResult,
  };
}

/**
 * Resolve VPC security group ids and subnet ids to human-readable names.
 * Each resolution is independent and best-effort (null → fall back to raw id).
 */
async function resolveVpcConfig(
  vpcConfig: RawLambdaVpcConfig,
  runOpts: AwsRunOptions,
): Promise<LambdaVpcSummary> {
  const sgIds = vpcConfig.SecurityGroupIds ?? [];
  const subnetIds = vpcConfig.SubnetIds ?? [];

  const [sgResults, subnetResults] = await Promise.all([
    Promise.all(
      sgIds.map((id) =>
        resolveSg({ id, binary: runOpts.binary, context: runOpts.context })
          .then((r) => r?.name ?? id)
          .catch(() => id),
      ),
    ),
    Promise.all(
      subnetIds.map((id) =>
        resolveSubnet({ id, binary: runOpts.binary, context: runOpts.context })
          .then((r) => r?.name ?? id)
          .catch(() => id),
      ),
    ),
  ]);

  return {
    vpcId: vpcConfig.VpcId ?? "",
    securityGroups: sgResults,
    subnets: subnetResults,
  };
}

// ─── Sub-operation implementations ───────────────────────────────────────────

async function runListFunctions(
  options: LambdaRunOptions,
): Promise<{ functions: LambdaListResult } | Record<string, unknown>> {
  // Track whether --max-items was explicitly provided before extractMaxItems
  // returns the default — needed for the --query bypass check below.
  const explicitMaxItems = extractFlag(options.args, "--max-items") !== undefined;
  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");
  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--max-items", "--next-token"], undefined, { service: "lambda", operation: "list-functions" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active and no explicit --max-items was given. Explicit --max-items is honored.
  const awsArgs: string[] = ["lambda", "list-functions"];
  if (!hasQuery || explicitMaxItems) {
    awsArgs.push("--max-items", String(maxItems));
  }
  if (nextTokenArg !== undefined) {
    awsArgs.push("--starting-token", nextTokenArg);
  }
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, runOpts);
  }

  const response = await awsJson<RawListFunctionsResponse>(awsArgs, runOpts);
  const fns = response.Functions ?? [];

  if (fns.length === 0) {
    return {
      functions: {
        items: [],
        count: "0 total",
        message: "No Lambda functions found in this account/region",
      },
    };
  }

  // Enrich all functions in parallel
  const enriched = await Promise.all(fns.map((fn) => enrichFunction(fn, options)));

  // Gate truncation ONLY on synthesized NextToken (botocore paginator contract)
  const nextToken = response.NextToken;

  return {
    functions: {
      items: enriched,
      count: countString(enriched.length, nextToken),
      ...(nextToken !== undefined ? { nextToken } : {}),
    },
  };
}

async function runGetFunction(
  options: LambdaRunOptions,
): Promise<{ function: LambdaFunctionSummary } | Record<string, unknown>> {
  const positionals = extractPositionals(options.args);
  if (positionals.length === 0) {
    throw new AxiError(
      "get-function requires a function name or ARN",
      "USAGE_ERROR",
      ["Usage: aws-axi lambda get-function <function-name>"],
    );
  }

  const fnName = positionals[0] as string;
  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract — e.g. --qualifier).
  const rawPassthrough = collectPassthroughFlags(options.args, [], undefined, { service: "lambda", operation: "get-function" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(
      ["lambda", "get-function", "--function-name", fnName, ...passthrough],
      runOpts,
    );
  }

  const response = await awsJson<RawGetFunctionResponse>(
    ["lambda", "get-function", "--function-name", fnName, ...passthrough],
    runOpts,
  );

  const enriched = await enrichFunction(response.Configuration, options);
  return { function: enriched };
}

async function runGetFunctionConfiguration(
  options: LambdaRunOptions,
): Promise<{ function: LambdaFunctionSummary } | Record<string, unknown>> {
  const positionals = extractPositionals(options.args);
  if (positionals.length === 0) {
    throw new AxiError(
      "get-function-configuration requires a function name or ARN",
      "USAGE_ERROR",
      ["Usage: aws-axi lambda get-function-configuration <function-name>"],
    );
  }

  const fnName = positionals[0] as string;
  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract — e.g. --qualifier).
  const rawPassthrough = collectPassthroughFlags(options.args, [], undefined, { service: "lambda", operation: "get-function-configuration" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(
      ["lambda", "get-function-configuration", "--function-name", fnName, ...passthrough],
      runOpts,
    );
  }

  const rawConfig = await awsJson<RawLambdaFunction>(
    ["lambda", "get-function-configuration", "--function-name", fnName, ...passthrough],
    runOpts,
  );

  const enriched = await enrichFunction(rawConfig, options);
  return { function: enriched };
}

/**
 * Invoke a Lambda function synchronously.
 *
 * `aws lambda invoke` writes the response payload to a file and prints
 * invocation metadata (StatusCode, FunctionError, ExecutedVersion) to stdout.
 * We create a temp file for the payload, read it back, then clean up.
 *
 * FunctionError is a function-level outcome (the invocation succeeded at the
 * infrastructure level but the function threw). It is surfaced as a field on
 * the result — NOT converted into an AxiError.
 */
async function runInvoke(
  options: LambdaRunOptions,
): Promise<{ invocation: LambdaInvokeResult } | Record<string, unknown>> {
  const fnName = extractFlag(options.args, "--function-name");
  if (fnName === undefined || fnName === "") {
    throw new AxiError(
      "invoke requires --function-name <name>",
      "USAGE_ERROR",
      [
        "Usage: aws-axi lambda invoke --function-name <name> [--payload <json>]",
        "Example: aws-axi lambda invoke --function-name my-function --payload '{}'",
      ],
    );
  }

  // Build aws args, forwarding optional invoke flags
  const invokeArgs: string[] = ["lambda", "invoke", "--function-name", fnName];

  const payload = extractFlag(options.args, "--payload");
  if (payload !== undefined) {
    invokeArgs.push("--payload", payload);
    // AWS CLI v2 defaults to base64 binary format. Pass raw-in-base64-out so a
    // literal JSON string is accepted as-is instead of rejected as invalid base64.
    // aws-cli/2 docs: "required if you're using AWS CLI v2" with a raw payload.
    invokeArgs.push("--cli-binary-format", "raw-in-base64-out");
  }

  const invocationType = extractFlag(options.args, "--invocation-type");
  if (invocationType !== undefined) {
    invokeArgs.push("--invocation-type", invocationType);
  }

  const logType = extractFlag(options.args, "--log-type");
  if (logType !== undefined) {
    invokeArgs.push("--log-type", logType);
  }

  // Forward unknown flags verbatim (superset contract).
  // Note: the outfile positional must come AFTER passthrough flags below.
  // invoke uses awsRaw (not awsJson) with outfile semantics — the payload is
  // written to a temp file, not returned as JSON. When --query is present the
  // AWS CLI applies JMESPath to the metadata response before printing it to
  // stdout; hasQuery bypasses our curated projection so the raw result is
  // surfaced instead (same bypass pattern as list-functions / get-function).
  const rawPassthrough = collectPassthroughFlags(
    options.args,
    ["--function-name", "--payload", "--invocation-type", "--log-type", "--cli-binary-format"],
    undefined,
    { service: "lambda", operation: "invoke" },
  );
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);
  invokeArgs.push(...passthrough);

  // Create a temp file for the response payload
  const tmpDir = mkdtempSync(join(tmpdir(), "aws-axi-lambda-invoke-"));
  const outfilePath = join(tmpDir, "response.json");

  try {
    // The outfile positional arg must come BEFORE --output json (which buildArgs appends)
    invokeArgs.push(outfilePath);

    const metadataResult = await awsRaw(invokeArgs, toRunOpts(options));

    // aws invoke: non-zero process exit means an infra-level failure (throttle,
    // function-not-found, auth, etc.). FunctionError on a zero-exit invocation
    // is a function-level outcome — surfaced as a result field, not an error.
    // NOTE: do NOT conflate HTTP StatusCode (200/400/...) with process exit code.
    if (metadataResult.exitCode !== 0) {
      const { mapAwsError } = await import("../errors.js");
      throw mapAwsError(metadataResult.stderr, metadataResult.exitCode);
    }

    // --query bypass: the AWS CLI has already applied JMESPath to the metadata
    // response; stdout contains the projected result (unknown shape). Attempting
    // to project it again through our curated schema would null every field.
    if (hasQuery) {
      try {
        return JSON.parse(metadataResult.stdout.trim()) as Record<string, unknown>;
      } catch {
        throw new AxiError(
          `Unexpected aws lambda invoke output: ${metadataResult.stdout.slice(0, 200)}`,
          "UNKNOWN",
        );
      }
    }

    // Parse invocation metadata from stdout
    let metadata: RawInvokeMetadata;
    try {
      metadata = JSON.parse(metadataResult.stdout) as RawInvokeMetadata;
    } catch {
      throw new AxiError(
        `Unexpected aws lambda invoke output: ${metadataResult.stdout.slice(0, 200)}`,
        "UNKNOWN",
      );
    }

    // Read response payload from outfile
    let payloadRaw: string;
    try {
      payloadRaw = readFileSync(outfilePath, "utf-8");
    } catch {
      payloadRaw = "";
    }

    // Decode payload: attempt JSON parse, fall back to raw string
    let decodedPayload: unknown;
    if (payloadRaw.trim() === "") {
      decodedPayload = null;
    } else {
      try {
        decodedPayload = JSON.parse(payloadRaw) as unknown;
      } catch {
        decodedPayload = payloadRaw;
      }
    }

    // Decode log tail (base64) if present
    let logTail: string | undefined;
    if (metadata.LogResult !== undefined && metadata.LogResult !== "") {
      try {
        logTail = Buffer.from(metadata.LogResult, "base64").toString("utf-8");
      } catch {
        logTail = metadata.LogResult;
      }
    }

    return {
      invocation: {
        statusCode: metadata.StatusCode,
        ...(metadata.FunctionError !== undefined
          ? { functionError: metadata.FunctionError }
          : {}),
        payload: decodedPayload,
        ...(logTail !== undefined ? { logTail } : {}),
      },
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ─── lambdaRun ────────────────────────────────────────────────────────────────

/**
 * Core Lambda logic — testable without the CLI layer.
 *
 * Dispatches to the appropriate sub-operation based on options.subcommand.
 * Throws AxiError on usage errors, auth failures, and AWS service errors.
 */
export async function lambdaRun(options: LambdaRunOptions): Promise<LambdaRunResult> {
  switch (options.subcommand) {
    case "list-functions":
    case "": // default when no subcommand given
      return runListFunctions(options);
    case "get-function":
      return runGetFunction(options);
    case "get-function-configuration":
      return runGetFunctionConfiguration(options);
    case "invoke":
      return runInvoke(options);
    default:
      throw new AxiError(
        `Unknown lambda subcommand: ${options.subcommand}`,
        "USAGE_ERROR",
        [
          "Valid subcommands: list-functions, get-function, get-function-configuration, invoke",
          "Run `aws-axi lambda --help` for full usage",
        ],
      );
  }
}

// ─── lambdaCommand ────────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter.
 *
 * Parses the first arg as the subcommand (defaulting to list-functions when
 * absent or a flag). Dispatches to lambdaRun and wraps the result under a
 * top-level `lambda` key for TOON rendering by the CLI layer.
 *
 * The `binary` parameter is for testing only — production omits it (uses "aws").
 */
export async function lambdaCommand(
  args: string[],
  context: AwsContext | undefined,
  binary?: string,
): Promise<Record<string, unknown>> {
  const firstArg = args[0] ?? "";

  let subcommand: string;
  let remainingArgs: string[];

  if (firstArg === "" || firstArg.startsWith("--")) {
    // No subcommand provided (or leading flag) — default to list-functions
    subcommand = "list-functions";
    remainingArgs = args.filter((a) => a !== "");
  } else if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    subcommand = firstArg;
    remainingArgs = args.slice(1);
  } else {
    // Not in the overlay's hot-path — delegate to the model-driven engine.
    // The engine validates against the botocore lambda model and surfaces a clean
    // USAGE_ERROR for ops that are genuinely unknown to AWS.
    return fallThroughToEngine("lambda", firstArg, args.slice(1), context);
  }

  const result = await lambdaRun({ subcommand, args: remainingArgs, context, binary });
  return { lambda: result };
}
