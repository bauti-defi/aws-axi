/**
 * `aws-axi ssm` — SSM Parameter Store read overlay.
 *
 * Mirrors `aws ssm <op>` 1:1 for read operations. Projects to curated TOON
 * with values REDACTED by default, capped pagination, definitive empty states,
 * and KMS alias enrichment on describe-parameters.
 *
 * Operations:
 *   get-parameter             Get a single parameter (value redacted by default)
 *   get-parameters            Get multiple parameters by name (values redacted)
 *   get-parameters-by-path    Get all parameters under a path prefix (values redacted)
 *   describe-parameters       List parameter metadata; resolves KMS alias where present
 *
 * Use --reveal to display actual values.
 *
 * Exports:
 *   ssmRun(options)       → typed SsmRunResult (testing / composition)
 *   ssmCommand(args, ctx) → AxiCliCommand adapter (CLI dispatch)
 *   SSM_HELP              → help text string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import type { AwsRunOptions } from "../aws.js";
import { awsJson } from "../aws.js";
import { resolveKey } from "../resolve/key.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REDACTED = "<redacted>";
const MAX_ITEMS_DEFAULT = 50;

const KNOWN_SUBCOMMANDS = new Set([
  "get-parameter",
  "get-parameters",
  "get-parameters-by-path",
  "describe-parameters",
]);

// ─── Raw AWS response shapes ──────────────────────────────────────────────────

interface RawSsmParameter {
  readonly Name: string;
  readonly Type: string;
  readonly Value: string;
  readonly Version: number;
  readonly LastModifiedDate: string;
  readonly ARN: string;
  readonly DataType: string;
}

interface RawGetParameterResponse {
  readonly Parameter: RawSsmParameter;
}

interface RawGetParametersResponse {
  readonly Parameters: readonly RawSsmParameter[];
  readonly InvalidParameters: readonly string[];
}

interface RawGetParametersByPathResponse {
  readonly Parameters: readonly RawSsmParameter[];
  readonly NextToken?: string;
}

interface RawParameterMetadata {
  readonly Name: string;
  readonly Type: string;
  readonly KeyId?: string;
  readonly LastModifiedDate: string;
  readonly Version: number;
  readonly Description?: string;
  readonly ARN: string;
  readonly DataType: string;
  readonly Tier: string;
}

interface RawDescribeParametersResponse {
  readonly Parameters: readonly RawParameterMetadata[];
  readonly NextToken?: string;
}

// ─── Public result shapes ─────────────────────────────────────────────────────

export interface SsmParameterEntry {
  readonly name: string;
  readonly type: string;
  readonly version: number;
  readonly lastModified: string;
  readonly arn: string;
  readonly dataType: string;
  /** Actual value when --reveal is passed; "<redacted>" otherwise. */
  readonly value: string;
}

export interface SsmParameterMetadata {
  readonly name: string;
  readonly type: string;
  readonly version: number;
  readonly lastModified: string;
  readonly arn: string;
  readonly dataType: string;
  readonly description: string | undefined;
  readonly tier: string;
  /** Resolved KMS alias for SecureString parameters, undefined otherwise. */
  readonly kmsKeyAlias: string | undefined;
}

export interface SsmGetParameterResult {
  readonly parameter: SsmParameterEntry;
  /** Hint to use --reveal when value is redacted; absent when revealed. */
  readonly suggestion?: string;
}

export interface SsmGetParametersResult {
  readonly parameters: readonly SsmParameterEntry[];
  readonly invalidParameters: readonly string[];
  readonly count: string;
  readonly suggestion?: string;
}

export interface SsmGetParametersByPathResult {
  readonly parameters: readonly SsmParameterEntry[];
  readonly count: string;
  readonly nextToken?: string;
  readonly message?: string;
  readonly suggestion?: string;
}

export interface SsmDescribeParametersResult {
  readonly parameters: readonly SsmParameterMetadata[];
  readonly count: string;
  readonly nextToken?: string;
  readonly message?: string;
  readonly suggestion?: string;
}

/** Discriminated union returned by ssmRun. */
export type SsmRunResult =
  | SsmGetParameterResult
  | { readonly parameterList: SsmGetParametersResult }
  | { readonly parametersByPath: SsmGetParametersByPathResult }
  | { readonly parametersMeta: SsmDescribeParametersResult };

export interface SsmRunOptions {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export const SSM_HELP = `usage: aws-axi ssm <subcommand> [flags]

subcommands:
  describe-parameters                List parameter metadata (default when omitted)
  get-parameter <name>               Get one parameter; value is redacted by default
  get-parameters <n1> [n2...]        Get multiple parameters by name
  get-parameters-by-path <path>      Get all parameters under a path prefix

flags (all subcommands):
  --profile <name>       AWS profile (inherited from global --profile)
  --region <region>      AWS region  (inherited from global --region)
  --reveal               Show actual parameter values (default: redacted)

flags (list operations):
  --max-items <n>        Cap results per page (default: ${MAX_ITEMS_DEFAULT})
  --next-token <token>   Resume a previous paginated call

flags (get-parameter, get-parameters):
  --name <name>          Parameter name (alternative to positional)
  --with-decryption      Passed through to aws when --reveal is active

flags (get-parameters-by-path):
  --path <path>          Parameter path prefix (alternative to positional)

examples:
  aws-axi ssm
  aws-axi ssm get-parameter /my/app/db-password
  aws-axi ssm get-parameter /my/app/db-password --reveal
  aws-axi ssm get-parameters /my/app/db-password /my/app/api-key
  aws-axi ssm get-parameters-by-path /my/app --max-items 20
  aws-axi ssm describe-parameters
  aws-axi ssm describe-parameters --max-items 10 --next-token AQE...
`;

// ─── Arg-parsing helpers ──────────────────────────────────────────────────────

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

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/**
 * Boolean flags that take no separate value token.
 * Without this list, extractPositionals would incorrectly consume the first
 * positional after a boolean flag as that flag's value.
 */
const BOOLEAN_FLAGS = new Set([
  "--reveal",
  "--with-decryption",
  "--no-with-decryption",
  "--recursive",
  "--no-recursive",
]);

function extractPositionals(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      // --flag=value form: value embedded, no separate token
      continue;
    }
    if (arg.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg)) {
        // Boolean flag — no value token follows; skip only this token
        continue;
      }
      // Value flag — skip this AND the following value token
      i++;
    } else if (arg !== "") {
      result.push(arg);
    }
  }
  return result;
}

function extractMaxItems(args: readonly string[]): number {
  const raw = extractFlag(args, "--max-items");
  if (raw === undefined) return MAX_ITEMS_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new AxiError(
      `--max-items must be a positive integer, got: ${raw}`,
      "USAGE_ERROR",
      [`Run \`aws-axi ssm --help\` to see valid flags`],
    );
  }
  return parsed;
}

function countString(n: number, nextToken: string | undefined): string {
  if (nextToken !== undefined) {
    return `showing ${n} (truncated); next-token=${nextToken}`;
  }
  return `${n} total`;
}

function maybeRedact(value: string, reveal: boolean): string {
  return reveal ? value : REDACTED;
}

function toRunOpts(options: SsmRunOptions): AwsRunOptions {
  return { binary: options.binary, context: options.context };
}

function toResolveOpts(options: SsmRunOptions) {
  return { binary: options.binary, context: options.context };
}

function projectParameter(
  raw: RawSsmParameter,
  reveal: boolean,
): SsmParameterEntry {
  return {
    name: raw.Name,
    type: raw.Type,
    version: raw.Version,
    lastModified: raw.LastModifiedDate,
    arn: raw.ARN,
    dataType: raw.DataType,
    value: maybeRedact(raw.Value, reveal),
  };
}

// ─── Sub-operations ───────────────────────────────────────────────────────────

async function runGetParameter(
  options: SsmRunOptions,
): Promise<SsmGetParameterResult> {
  const reveal = hasFlag(options.args, "--reveal");
  const positionals = extractPositionals(options.args);
  const nameArg =
    extractFlag(options.args, "--name") ?? positionals[0];

  if (nameArg === undefined || nameArg === "") {
    throw new AxiError(
      "get-parameter requires a parameter name",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm get-parameter <name>",
        "Accepted forms: /path/to/param or --name /path/to/param",
      ],
    );
  }

  const awsArgs = ["ssm", "get-parameter", "--name", nameArg];
  if (reveal) {
    awsArgs.push("--with-decryption");
  }

  const response = await awsJson<RawGetParameterResponse>(awsArgs, toRunOpts(options));

  return {
    parameter: projectParameter(response.Parameter, reveal),
    ...(reveal ? {} : { suggestion: "Pass --reveal to show the actual value" }),
  };
}

async function runGetParameters(
  options: SsmRunOptions,
): Promise<{ parameterList: SsmGetParametersResult }> {
  const reveal = hasFlag(options.args, "--reveal");
  const positionals = extractPositionals(options.args);

  // --names flag value (single space-separated string from CLI) or positionals
  const namesFlag = extractFlag(options.args, "--names");
  const names: string[] =
    namesFlag !== undefined
      ? namesFlag.split(/\s+/).filter((n) => n !== "")
      : positionals;

  if (names.length === 0) {
    throw new AxiError(
      "get-parameters requires at least one parameter name",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm get-parameters <name1> [name2...]",
        "Or: aws-axi ssm get-parameters --names '/p1 /p2'",
      ],
    );
  }

  const awsArgs = ["ssm", "get-parameters", "--names", ...names];
  if (reveal) {
    awsArgs.push("--with-decryption");
  }

  const response = await awsJson<RawGetParametersResponse>(awsArgs, toRunOpts(options));
  const params = response.Parameters ?? [];
  const invalid = response.InvalidParameters ?? [];

  return {
    parameterList: {
      parameters: params.map((p) => projectParameter(p, reveal)),
      invalidParameters: [...invalid],
      count: countString(params.length, undefined),
      ...(reveal ? {} : { suggestion: "Pass --reveal to show actual values" }),
    },
  };
}

async function runGetParametersByPath(
  options: SsmRunOptions,
): Promise<{ parametersByPath: SsmGetParametersByPathResult }> {
  const reveal = hasFlag(options.args, "--reveal");
  const positionals = extractPositionals(options.args);
  const pathArg =
    extractFlag(options.args, "--path") ?? positionals[0];

  if (pathArg === undefined || pathArg === "") {
    throw new AxiError(
      "get-parameters-by-path requires a path prefix",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm get-parameters-by-path <path>",
        "Example: aws-axi ssm get-parameters-by-path /my/app",
      ],
    );
  }

  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");

  const awsArgs = [
    "ssm",
    "get-parameters-by-path",
    "--path",
    pathArg,
    "--max-items",
    String(maxItems),
  ];
  if (reveal) {
    awsArgs.push("--with-decryption");
  }
  if (nextTokenArg !== undefined) {
    awsArgs.push("--starting-token", nextTokenArg);
  }

  const response = await awsJson<RawGetParametersByPathResponse>(
    awsArgs,
    toRunOpts(options),
  );
  const params = response.Parameters ?? [];
  const nextToken = response.NextToken;

  if (params.length === 0) {
    return {
      parametersByPath: {
        parameters: [],
        count: "0 total",
        message: `No parameters found under path: ${pathArg}`,
        suggestion: `List parameters with \`aws-axi ssm describe-parameters\``,
      },
    };
  }

  return {
    parametersByPath: {
      parameters: params.map((p) => projectParameter(p, reveal)),
      count: countString(params.length, nextToken),
      ...(nextToken !== undefined ? { nextToken } : {}),
      ...(reveal ? {} : { suggestion: "Pass --reveal to show actual values" }),
    },
  };
}

async function runDescribeParameters(
  options: SsmRunOptions,
): Promise<{ parametersMeta: SsmDescribeParametersResult }> {
  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");

  const awsArgs = ["ssm", "describe-parameters", "--max-items", String(maxItems)];
  if (nextTokenArg !== undefined) {
    awsArgs.push("--starting-token", nextTokenArg);
  }

  const response = await awsJson<RawDescribeParametersResponse>(
    awsArgs,
    toRunOpts(options),
  );
  const params = response.Parameters ?? [];
  const nextToken = response.NextToken;

  if (params.length === 0) {
    return {
      parametersMeta: {
        parameters: [],
        count: "0 total",
        message: "No SSM parameters found in this account/region",
        suggestion:
          'Create a parameter with `aws ssm put-parameter --name /my/param --value <value> --type String`',
      },
    };
  }

  // Resolve KMS aliases for unique keyIds (SecureString parameters only)
  const uniqueKeyIds = [
    ...new Set(
      params
        .map((p) => p.KeyId)
        .filter((k): k is string => k !== undefined && k !== ""),
    ),
  ];

  const resolveOpts = toResolveOpts(options);
  const resolvedEntries = await Promise.all(
    uniqueKeyIds.map(async (keyId) => {
      const resolved = await resolveKey(keyId, resolveOpts).catch(() => undefined);
      return [keyId, resolved?.alias ?? undefined] as const;
    }),
  );
  const aliasMap = new Map<string, string | undefined>(resolvedEntries);

  const projected: SsmParameterMetadata[] = params.map((p) => ({
    name: p.Name,
    type: p.Type,
    version: p.Version,
    lastModified: p.LastModifiedDate,
    arn: p.ARN,
    dataType: p.DataType,
    description: p.Description,
    tier: p.Tier,
    kmsKeyAlias:
      p.KeyId !== undefined ? (aliasMap.get(p.KeyId) ?? undefined) : undefined,
  }));

  return {
    parametersMeta: {
      parameters: projected,
      count: countString(projected.length, nextToken),
      ...(nextToken !== undefined ? { nextToken } : {}),
    },
  };
}

// ─── ssmRun ───────────────────────────────────────────────────────────────────

/**
 * Core SSM logic — testable without the CLI layer.
 *
 * Dispatches to the appropriate sub-operation based on options.subcommand.
 * Empty subcommand defaults to describe-parameters.
 */
export async function ssmRun(options: SsmRunOptions): Promise<SsmRunResult> {
  switch (options.subcommand) {
    case "describe-parameters":
    case "": // default
      return runDescribeParameters(options);
    case "get-parameter":
      return runGetParameter(options);
    case "get-parameters":
      return runGetParameters(options);
    case "get-parameters-by-path":
      return runGetParametersByPath(options);
    default:
      throw new AxiError(
        `Unknown ssm subcommand: ${options.subcommand}`,
        "USAGE_ERROR",
        [
          "Valid subcommands: get-parameter, get-parameters, get-parameters-by-path, describe-parameters",
          "Run `aws-axi ssm --help` for full usage",
        ],
      );
  }
}

// ─── ssmCommand ───────────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter.
 *
 * Parses the first arg as the subcommand (defaulting to describe-parameters
 * when absent or a flag), dispatches to ssmRun, and wraps the result under
 * a top-level `ssm` key for TOON rendering by the CLI layer.
 */
export async function ssmCommand(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const firstArg = args[0] ?? "";

  let subcommand: string;
  let remainingArgs: string[];

  if (firstArg === "" || firstArg.startsWith("--")) {
    subcommand = "describe-parameters";
    remainingArgs = args.filter((a) => a !== "");
  } else if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    subcommand = firstArg;
    remainingArgs = args.slice(1);
  } else {
    throw new AxiError(
      `Unknown ssm subcommand: ${firstArg}`,
      "USAGE_ERROR",
      [
        "Valid subcommands: get-parameter, get-parameters, get-parameters-by-path, describe-parameters",
        "Run `aws-axi ssm --help` for full usage",
      ],
    );
  }

  const result = await ssmRun({ subcommand, args: remainingArgs, context });
  return { ssm: result };
}
