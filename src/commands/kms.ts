/**
 * `aws-axi kms` — KMS read overlay.
 *
 * Mirrors `aws kms <op>` 1:1 for read operations. Projects to curated TOON
 * with alias resolution, capped pagination, definitive empty states, and
 * structured errors.
 *
 * Operations: list-keys · list-aliases · describe-key · get-key-policy
 *
 * Exports:
 *   kmsRun(options)       → typed KmsRunResult (testing / composition)
 *   kmsCommand(args, ctx) → AxiCliCommand adapter (CLI dispatch)
 *   KMS_HELP              → help text string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import type { AwsRunOptions } from "../aws.js";
import { awsJson } from "../aws.js";
import { loadAliasMap } from "../resolve/key.js";
import { fallThroughToEngine } from "../engine.js";
import { collectPassthroughFlags, buildPassthrough } from "../overlay-args.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITEMS_DEFAULT = 50;

const KNOWN_SUBCOMMANDS = new Set([
  "list-keys",
  "list-aliases",
  "describe-key",
  "get-key-policy",
]);

// ─── Raw AWS response shapes ──────────────────────────────────────────────────

interface RawKmsKey {
  readonly KeyId: string;
  readonly KeyArn: string;
}

interface RawListKeysResponse {
  readonly Keys: readonly RawKmsKey[];
  readonly NextToken?: string;
}

interface RawKmsAlias {
  readonly AliasName: string;
  readonly AliasArn: string;
  readonly TargetKeyId: string | undefined;
  readonly CreationDate: string | undefined;
  readonly LastUpdatedDate: string | undefined;
}

interface RawListAliasesResponse {
  readonly Aliases: readonly RawKmsAlias[];
  readonly NextToken?: string;
}

interface RawKmsKeyMetadata {
  readonly KeyId: string;
  readonly Arn: string;
  readonly Enabled: boolean;
  readonly Description: string;
  readonly KeyState: string;
  readonly KeyManager: string;
  readonly KeyUsage: string;
  readonly KeySpec: string;
}

interface RawDescribeKeyResponse {
  readonly KeyMetadata: RawKmsKeyMetadata;
}

interface RawGetKeyPolicyResponse {
  readonly Policy: string;
}

// ─── Public result shapes ─────────────────────────────────────────────────────

export interface KmsKeyEntry {
  readonly keyId: string;
  readonly arn: string;
  /** Primary alias for this key, undefined if none. */
  readonly alias: string | undefined;
}

export interface KmsListKeysResult {
  readonly keys: readonly KmsKeyEntry[];
  /** Human-readable count/pagination summary. */
  readonly count: string;
  /** Present when the response was truncated; pass to --next-token to continue. */
  readonly nextToken?: string;
  /** Set on empty result. */
  readonly message?: string;
  /** Actionable suggestion on empty result. */
  readonly suggestion?: string;
}

export interface KmsKeyDetail {
  readonly keyId: string;
  readonly arn: string;
  readonly alias: string | undefined;
  readonly enabled: boolean;
  readonly state: string;
  readonly keyManager: string;
  readonly description: string;
  readonly keyUsage: string;
  readonly keySpec: string;
}

export interface KmsAliasEntry {
  readonly aliasName: string;
  readonly aliasArn: string;
  readonly targetKeyId: string | undefined;
}

export interface KmsListAliasesResult {
  readonly aliases: readonly KmsAliasEntry[];
  readonly count: string;
  readonly nextToken?: string;
  readonly message?: string;
  readonly suggestion?: string;
}

export interface KmsKeyPolicy {
  readonly keyId: string;
  readonly policyName: string;
  /** Parsed policy document (or raw string if not valid JSON). */
  readonly policy: unknown;
}

/** Discriminated union returned by kmsRun. Raw Record when --query bypass is active. */
export type KmsRunResult =
  | { readonly listKeys: KmsListKeysResult }
  | { readonly key: KmsKeyDetail }
  | { readonly listAliases: KmsListAliasesResult }
  | { readonly keyPolicy: KmsKeyPolicy }
  | Record<string, unknown>;

export interface KmsRunOptions {
  readonly subcommand: string;
  /** Remaining args after the subcommand has been extracted. */
  readonly args: readonly string[];
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export const KMS_HELP = `usage: aws-axi kms <subcommand> [flags]

Any flag accepted by the underlying \`aws kms\` operation (e.g. --grant-tokens,
--key-usage, --query) is forwarded verbatim — overlays never restrict the input
contract, only enrich the output.

subcommands (enriched overlays):
  list-keys             List all KMS keys (default when omitted)
  list-aliases          List all key aliases
  describe-key <id>     Describe a key by id, ARN, or alias
  get-key-policy <id>   Get the default key policy
  (any other kms subcommand falls through to the generic engine — run \`aws kms help\` to list all)

flags (overlay-specific):
  --profile <name>      AWS profile (inherited from global --profile)
  --region <region>     AWS region  (inherited from global --region)
  --query <expr>        JMESPath; bypasses overlay projection, returns raw result
  --output              stripped (aws-axi always uses --output json internally)

flags (list-keys, list-aliases):
  --max-items <n>       Cap results per page (default: ${MAX_ITEMS_DEFAULT})
  --next-token <token>  Resume a previous paginated call

flags (list-aliases):
  --key-id <id>         Filter aliases for a specific key

flags (get-key-policy):
  --policy-name <name>  Policy name (default: default)

examples:
  aws-axi kms list-keys
  aws-axi kms list-keys --key-usage ENCRYPT_DECRYPT     # forwarded to aws
  aws-axi kms list-aliases
  aws-axi kms describe-key alias/my-key
  aws-axi kms describe-key alias/my-key --grant-tokens token1  # forwarded to aws
  aws-axi kms describe-key arn:aws:kms:us-east-1:123456789012:key/abcd-1234
  aws-axi kms get-key-policy alias/my-key
  aws-axi kms list-keys --max-items 10
  aws-axi kms list-keys --next-token AQE...
  aws-axi kms list-aliases --key-id alias/my-key
`;

// ─── Arg-parsing helpers ──────────────────────────────────────────────────────

/**
 * Extract the value of a named flag.
 *
 * Accepts both forms that agents commonly use:
 *   --flag value   (space-separated)
 *   --flag=value   (equals-separated)
 *
 * The global `--profile`/`--region` flags already support both forms via
 * context.ts; all KMS flags must be consistent.
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
      [`Run \`aws-axi kms --help\` to see valid flags`],
    );
  }
  return parsed;
}

/**
 * Extract bare positional arguments (non-flag tokens) from args.
 *
 * Handles both flag forms:
 *   --flag value   → skip flag token AND the following value token
 *   --flag=value   → skip only the combined token (value is embedded)
 */
function extractPositionals(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      // --flag=value form: value embedded, skip only this token
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

function toRunOpts(options: KmsRunOptions): AwsRunOptions {
  return { binary: options.binary, context: options.context };
}

// ─── Sub-operations ───────────────────────────────────────────────────────────

async function runListKeys(
  options: KmsRunOptions,
): Promise<{ listKeys: KmsListKeysResult } | Record<string, unknown>> {
  // Track whether --max-items was explicitly provided before extractMaxItems
  // returns the default — needed for the --query bypass check below.
  const explicitMaxItems = extractFlag(options.args, "--max-items") !== undefined;
  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");
  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--max-items", "--next-token"], undefined, { service: "kms", operation: "list-keys" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active and no explicit --max-items was given. JMESPath projects NextToken
  // away; the cap would cause silent truncation. Without --max-items, botocore
  // auto-pages to completion. An explicit --max-items is always honored.
  const awsArgs: string[] = ["kms", "list-keys"];
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

  // Fetch the key list and all aliases in parallel; alias map failure is
  // non-fatal (degrade gracefully to no-alias display).
  const [listResult, aliasMap] = await Promise.all([
    awsJson<RawListKeysResponse>(awsArgs, runOpts),
    loadAliasMap({ binary: options.binary, context: options.context }).catch(
      () => new Map<string, string>(),
    ),
  ]);

  const keys = listResult.Keys ?? [];

  if (keys.length === 0) {
    return {
      listKeys: {
        keys: [],
        count: "0 total",
        message: "No KMS keys found in this account/region",
        suggestion: 'Create a key with `aws kms create-key --description "my key"`',
      },
    };
  }

  const mapped: KmsKeyEntry[] = keys.map((k) => ({
    keyId: k.KeyId,
    arn: k.KeyArn,
    alias: aliasMap.get(k.KeyId),
  }));

  return {
    listKeys: {
      keys: mapped,
      count: countString(mapped.length, listResult.NextToken),
      ...(listResult.NextToken !== undefined
        ? { nextToken: listResult.NextToken }
        : {}),
    },
  };
}

async function runListAliases(
  options: KmsRunOptions,
): Promise<{ listAliases: KmsListAliasesResult } | Record<string, unknown>> {
  // Track whether --max-items was explicitly provided before extractMaxItems
  // returns the default — needed for the --query bypass check below.
  const explicitMaxItems = extractFlag(options.args, "--max-items") !== undefined;
  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");
  const keyIdArg = extractFlag(options.args, "--key-id");
  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(
    options.args,
    ["--max-items", "--next-token", "--key-id"],
    undefined,
    { service: "kms", operation: "list-aliases" },
  );
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active and no explicit --max-items was given. Explicit --max-items is honored.
  const awsArgs: string[] = ["kms", "list-aliases"];
  if (!hasQuery || explicitMaxItems) {
    awsArgs.push("--max-items", String(maxItems));
  }
  if (keyIdArg !== undefined) {
    awsArgs.push("--key-id", keyIdArg);
  }
  if (nextTokenArg !== undefined) {
    awsArgs.push("--starting-token", nextTokenArg);
  }
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, runOpts);
  }

  const response = await awsJson<RawListAliasesResponse>(awsArgs, runOpts);
  const aliases = response.Aliases ?? [];

  if (aliases.length === 0) {
    return {
      listAliases: {
        aliases: [],
        count: "0 total",
        message:
          keyIdArg !== undefined
            ? `No aliases found for key ${keyIdArg}`
            : "No KMS aliases found in this account/region",
        suggestion:
          'Create an alias with `aws kms create-alias --alias-name alias/my-key --target-key-id <key-id>`',
      },
    };
  }

  const mapped: KmsAliasEntry[] = aliases.map((a) => ({
    aliasName: a.AliasName,
    aliasArn: a.AliasArn,
    targetKeyId: a.TargetKeyId,
  }));

  return {
    listAliases: {
      aliases: mapped,
      count: countString(mapped.length, response.NextToken),
      ...(response.NextToken !== undefined
        ? { nextToken: response.NextToken }
        : {}),
    },
  };
}

async function runDescribeKey(
  options: KmsRunOptions,
): Promise<{ key: KmsKeyDetail } | Record<string, unknown>> {
  const positionals = extractPositionals(options.args);
  if (positionals.length === 0) {
    throw new AxiError(
      "describe-key requires a key id, ARN, or alias",
      "USAGE_ERROR",
      [
        "Usage: aws-axi kms describe-key <id>",
        "Accepted forms: UUID key-id · key ARN · alias/name · alias ARN",
      ],
    );
  }

  const keyInput = positionals[0] as string;
  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract). Bare positionals
  // (the key id) are skipped by collectPassthroughFlags automatically.
  const rawPassthrough = collectPassthroughFlags(options.args, [], undefined, { service: "kms", operation: "describe-key" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(
      ["kms", "describe-key", "--key-id", keyInput, ...passthrough],
      runOpts,
    );
  }

  const describeResult = await awsJson<RawDescribeKeyResponse>(
    ["kms", "describe-key", "--key-id", keyInput, ...passthrough],
    runOpts,
  );
  const meta = describeResult.KeyMetadata;

  const aliasResponse = await awsJson<{ Aliases: readonly RawKmsAlias[] }>(
    ["kms", "list-aliases", "--key-id", meta.KeyId],
    runOpts,
  );
  const primaryAlias = aliasResponse.Aliases[0]?.AliasName;

  return {
    key: {
      keyId: meta.KeyId,
      arn: meta.Arn,
      alias: primaryAlias,
      enabled: meta.Enabled,
      state: meta.KeyState,
      keyManager: meta.KeyManager,
      description: meta.Description,
      keyUsage: meta.KeyUsage,
      keySpec: meta.KeySpec,
    },
  };
}

async function runGetKeyPolicy(
  options: KmsRunOptions,
): Promise<{ keyPolicy: KmsKeyPolicy } | Record<string, unknown>> {
  const positionals = extractPositionals(options.args);
  if (positionals.length === 0) {
    throw new AxiError(
      "get-key-policy requires a key id, ARN, or alias",
      "USAGE_ERROR",
      ["Usage: aws-axi kms get-key-policy <id> [--policy-name <name>]"],
    );
  }

  const keyInput = positionals[0] as string;
  const policyName = extractFlag(options.args, "--policy-name") ?? "default";
  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--policy-name"], undefined, { service: "kms", operation: "get-key-policy" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(
      ["kms", "get-key-policy", "--key-id", keyInput, "--policy-name", policyName, ...passthrough],
      runOpts,
    );
  }

  const policyResult = await awsJson<RawGetKeyPolicyResponse>(
    [
      "kms",
      "get-key-policy",
      "--key-id",
      keyInput,
      "--policy-name",
      policyName,
      ...passthrough,
    ],
    runOpts,
  );

  let parsedPolicy: unknown;
  try {
    parsedPolicy = JSON.parse(policyResult.Policy) as unknown;
  } catch {
    // Policy is unexpectedly not JSON — surface it as-is
    parsedPolicy = policyResult.Policy;
  }

  return {
    keyPolicy: {
      keyId: keyInput,
      policyName,
      policy: parsedPolicy,
    },
  };
}

// ─── kmsRun ───────────────────────────────────────────────────────────────────

/**
 * Core KMS logic — testable without the CLI layer.
 *
 * Dispatches to the appropriate sub-operation based on options.subcommand.
 * Throws AxiError on usage errors, auth failures, and AWS service errors.
 */
export async function kmsRun(options: KmsRunOptions): Promise<KmsRunResult> {
  switch (options.subcommand) {
    case "list-keys":
    case "": // default: list-keys
      return runListKeys(options);
    case "list-aliases":
      return runListAliases(options);
    case "describe-key":
      return runDescribeKey(options);
    case "get-key-policy":
      return runGetKeyPolicy(options);
    default:
      throw new AxiError(
        `Unknown kms subcommand: ${options.subcommand}`,
        "USAGE_ERROR",
        [
          "Valid subcommands: list-keys, list-aliases, describe-key, get-key-policy",
          "Run `aws-axi kms --help` for full usage",
        ],
      );
  }
}

// ─── kmsCommand ───────────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter.
 *
 * Parses the first arg as the subcommand (defaulting to list-keys when absent
 * or a flag), dispatches to kmsRun, and wraps the result under a top-level
 * `kms` key for TOON rendering by the CLI layer.
 */
export async function kmsCommand(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const firstArg = args[0] ?? "";

  // Determine subcommand vs default
  let subcommand: string;
  let remainingArgs: string[];

  if (firstArg === "" || firstArg.startsWith("--")) {
    // No subcommand provided (or leading flag) — default to list-keys
    subcommand = "list-keys";
    remainingArgs = args.filter((a) => a !== "");
  } else if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    subcommand = firstArg;
    remainingArgs = args.slice(1);
  } else {
    // Not in the overlay's hot-path — delegate to the model-driven engine.
    // The engine validates against the botocore kms model and surfaces a clean
    // USAGE_ERROR for ops that are genuinely unknown to AWS.
    return fallThroughToEngine("kms", firstArg, args.slice(1), context);
  }

  const result = await kmsRun({ subcommand, args: remainingArgs, context });
  return { kms: result };
}
