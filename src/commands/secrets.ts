/**
 * `aws-axi secretsmanager` — Secrets Manager read overlay.
 *
 * Mirrors `aws secretsmanager <op>` 1:1 for read operations. Projects to
 * curated TOON with secret values REDACTED by default, KMS alias enrichment,
 * capped pagination, and definitive empty states.
 *
 * Operations:
 *   list-secrets          List all secrets with curated metadata (default)
 *   get-secret-value      Get a secret; value is redacted by default
 *   describe-secret       Describe a secret (no value — metadata + KMS alias)
 *
 * Use --reveal to display actual secret values (get-secret-value only).
 *
 * Also exported as `secretsCommand` for both the `secretsmanager` command
 * and the `secrets` alias.
 *
 * Exports:
 *   secretsRun(options)       → typed SecretsRunResult (testing / composition)
 *   secretsCommand(args, ctx) → AxiCliCommand adapter (CLI dispatch)
 *   SECRETS_HELP              → help text string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import type { AwsRunOptions } from "../aws.js";
import { awsJson } from "../aws.js";
import { resolveKey } from "../resolve/key.js";
import { fallThroughToEngine } from "../engine.js";
import { collectPassthroughFlags, buildPassthrough, extractFlag, flagIsTrueStrict, extractPositionals } from "../overlay-args.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REDACTED = "<redacted>";
const MAX_ITEMS_DEFAULT = 50;

const KNOWN_SUBCOMMANDS = new Set([
  "list-secrets",
  "get-secret-value",
  "describe-secret",
]);

// ─── Raw AWS response shapes ──────────────────────────────────────────────────

interface RawGetSecretValueResponse {
  readonly ARN: string;
  readonly Name: string;
  readonly VersionId: string;
  readonly SecretString?: string;
  readonly SecretBinary?: string;
  readonly VersionStages: readonly string[];
  readonly CreatedDate: string;
  readonly LastChangedDate?: string;
}

interface RawSecretListEntry {
  readonly ARN: string;
  readonly Name: string;
  readonly Description?: string;
  readonly KmsKeyId?: string;
  readonly RotationEnabled?: boolean;
  readonly LastRotatedDate?: string;
  readonly LastChangedDate?: string;
  readonly LastAccessedDate?: string;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

interface RawListSecretsResponse {
  readonly SecretList: readonly RawSecretListEntry[];
  readonly NextToken?: string;
}

interface RawDescribeSecretResponse {
  readonly ARN: string;
  readonly Name: string;
  readonly Description?: string;
  readonly KmsKeyId?: string;
  readonly RotationEnabled?: boolean;
  readonly LastRotatedDate?: string;
  readonly LastChangedDate?: string;
  readonly LastAccessedDate?: string;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

// ─── Public result shapes ─────────────────────────────────────────────────────

export interface SecretsGetValueResult {
  readonly name: string;
  readonly arn: string;
  readonly versionId: string;
  /** Actual value when --reveal is passed; "<redacted>" otherwise. */
  readonly secretValue: string;
  readonly versionStages: readonly string[];
  readonly lastChanged: string | undefined;
  /** KMS alias of the encrypting key, resolved via resolve-key. */
  readonly kmsKeyAlias: string | undefined;
}

export interface SecretsListEntry {
  readonly name: string;
  readonly arn: string;
  readonly description: string | undefined;
  readonly rotationEnabled: boolean;
  readonly lastChanged: string | undefined;
  readonly lastRotated: string | undefined;
  /** KMS alias of the encrypting key, resolved via resolve-key. */
  readonly kmsKeyAlias: string | undefined;
}

export interface SecretsListResult {
  readonly secrets: readonly SecretsListEntry[];
  readonly count: string;
  readonly nextToken?: string;
  readonly message?: string;
  readonly suggestion?: string;
}

export interface SecretsDetailResult {
  readonly name: string;
  readonly arn: string;
  readonly description: string | undefined;
  readonly rotationEnabled: boolean;
  readonly lastChanged: string | undefined;
  readonly lastRotated: string | undefined;
  /** KMS alias of the encrypting key, resolved via resolve-key. */
  readonly kmsKeyAlias: string | undefined;
}

/** Discriminated union returned by secretsRun. Raw Record when --query bypass is active. */
export type SecretsRunResult =
  | { readonly secret: SecretsGetValueResult; readonly suggestion?: string }
  | { readonly secretList: SecretsListResult }
  | { readonly secretDetail: SecretsDetailResult }
  | Record<string, unknown>;

export interface SecretsRunOptions {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export const SECRETS_HELP = `usage: aws-axi secretsmanager <subcommand> [flags]
       aws-axi secrets <subcommand> [flags]    (alias)

Any flag accepted by the underlying \`aws secretsmanager\` operation (e.g.
--filters, --sort-order, --query) is forwarded verbatim — overlays never
restrict the input contract, only enrich the output.

subcommands (enriched overlays):
  list-secrets                   List all secrets with curated metadata (default)
  get-secret-value <id>          Get a secret; value is redacted by default
  describe-secret <id>           Describe a secret (metadata only; no value)
  (any other secretsmanager subcommand falls through to the generic engine — run \`aws secretsmanager help\` to list all)

flags (overlay-specific):
  --profile <name>      AWS profile (inherited from global --profile)
  --region <region>     AWS region  (inherited from global --region)
  --reveal              Show actual secret value (get-secret-value only)
  --query <expr>        JMESPath; bypasses overlay projection, returns raw result.
                        Output is unbounded (botocore auto-pages all results; default
                        cap suppressed). To bound output, pass --max-items N.
  --output              stripped (aws-axi always uses --output json internally)

flags (list-secrets):
  --max-items <n>       Cap results per page (default: ${MAX_ITEMS_DEFAULT})
  --next-token <token>  Resume a previous paginated call

flags (get-secret-value, describe-secret):
  --secret-id <id>      Secret name or ARN (alternative to positional)

examples:
  aws-axi secretsmanager
  aws-axi secretsmanager list-secrets
  aws-axi secretsmanager list-secrets --filters Key=name,Values=prod  # forwarded
  aws-axi secretsmanager get-secret-value prod/my-app/db-password
  aws-axi secretsmanager get-secret-value prod/my-app/db-password --reveal
  aws-axi secretsmanager describe-secret prod/my-app/db-password
  aws-axi secrets list-secrets --max-items 10
`;

// ─── Arg-parsing helpers ──────────────────────────────────────────────────────

/**
 * Boolean flags for the secretsmanager overlay.
 *
 * These flags take no separate value token in the default (bare) case but
 * accept a recognised boolean literal in two-arg form (e.g. `--reveal false`).
 * Passed to the shared `extractPositionals` from `overlay-args.ts`.
 */
const SECRETS_BOOL_FLAGS = new Set([
  "--reveal",
  "--include-planned-deletion",
  "--no-include-planned-deletion",
]);

function extractMaxItems(args: readonly string[]): number {
  const raw = extractFlag(args, "--max-items");
  if (raw === undefined) return MAX_ITEMS_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new AxiError(
      `--max-items must be a positive integer, got: ${raw}`,
      "USAGE_ERROR",
      [`Run \`aws-axi secretsmanager --help\` to see valid flags`],
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

function toRunOpts(options: SecretsRunOptions): AwsRunOptions {
  return { binary: options.binary, context: options.context };
}

function toResolveOpts(options: SecretsRunOptions) {
  return { binary: options.binary, context: options.context };
}

/**
 * Resolve a KMS key identifier to its alias.
 * Returns the alias string on success; undefined on any failure (graceful degradation).
 */
async function resolveAlias(
  keyId: string,
  options: SecretsRunOptions,
): Promise<string | undefined> {
  const resolved = await resolveKey(keyId, toResolveOpts(options)).catch(() => undefined);
  return resolved?.alias;
}

/**
 * Bulk-resolve a set of unique key identifiers to aliases.
 * Returns a Map<keyId, alias | undefined>.
 */
async function resolveAliasMap(
  keyIds: readonly string[],
  options: SecretsRunOptions,
): Promise<ReadonlyMap<string, string | undefined>> {
  const unique = [...new Set(keyIds)];
  const entries = await Promise.all(
    unique.map(async (id) => [id, await resolveAlias(id, options)] as const),
  );
  return new Map(entries);
}

// ─── Sub-operations ───────────────────────────────────────────────────────────

async function runGetSecretValue(
  options: SecretsRunOptions,
): Promise<{ secret: SecretsGetValueResult; suggestion?: string } | Record<string, unknown>> {
  // flagIsTrueStrict: fail-safe for confidentiality — unrecognised value → redact.
  // hasFlag was value-blind: --reveal=false returned true and leaked the secret.
  const reveal = flagIsTrueStrict(options.args, "--reveal");
  const positionals = extractPositionals(options.args, SECRETS_BOOL_FLAGS);
  const secretId =
    extractFlag(options.args, "--secret-id") ?? positionals[0];

  if (secretId === undefined || secretId === "") {
    throw new AxiError(
      "get-secret-value requires a secret name or ARN",
      "USAGE_ERROR",
      [
        "Usage: aws-axi secretsmanager get-secret-value <id>",
        "Or: aws-axi secretsmanager get-secret-value --secret-id <id>",
      ],
    );
  }

  const runOpts = toRunOpts(options);

  // Forward unknown flags verbatim (superset contract). --reveal is overlay-only.
  const rawPassthrough = collectPassthroughFlags(options.args, ["--secret-id"], ["--reveal"], { service: "secretsmanager", operation: "get-secret-value" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  // --query bypass guard: GetSecretValue ALWAYS returns SecretString in plaintext
  // from AWS — there is no server-side redaction.  --query with no --reveal would
  // expose the plaintext via the JMESPath projection, bypassing redaction silently.
  //
  // ADR-0002 carve-out: --reveal is aws-axi's OWN flag (real aws has no such
  // concept), so gating on it does NOT violate the superset input contract — we
  // are guarding a confidentiality control we invented, not restricting an input
  // that real aws accepts.
  //
  // Scope: ONLY get-secret-value.  SSM is NOT affected: --with-decryption is only
  // appended when reveal=true, so an un-revealed SecureString is returned as
  // ciphertext by the server — nothing to leak via --query.  list-secrets and
  // describe-secret do not return secret values.
  if (hasQuery && !reveal) {
    throw new AxiError(
      "--query on a secret-bearing operation would bypass redaction.",
      "USAGE_ERROR",
      [
        "Pass --reveal to confirm you want the plaintext, or drop --query.",
      ],
    );
  }

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(
      ["secretsmanager", "get-secret-value", "--secret-id", secretId, ...passthrough],
      toRunOpts(options),
    );
  }

  // Fetch the secret value and its metadata in parallel.
  // describe-secret provides KmsKeyId for alias enrichment.
  // If describe-secret fails, we degrade gracefully.
  const [valueResponse, describeResponse] = await Promise.all([
    awsJson<RawGetSecretValueResponse>(
      ["secretsmanager", "get-secret-value", "--secret-id", secretId, ...passthrough],
      runOpts,
    ),
    awsJson<RawDescribeSecretResponse>(
      ["secretsmanager", "describe-secret", "--secret-id", secretId],
      runOpts,
    ).catch(() => undefined),
  ]);

  const kmsKeyId = describeResponse?.KmsKeyId;
  const kmsKeyAlias =
    kmsKeyId !== undefined
      ? await resolveAlias(kmsKeyId, options)
      : undefined;

  const rawValue =
    valueResponse.SecretString ??
    (valueResponse.SecretBinary !== undefined ? "<binary>" : "");

  return {
    secret: {
      name: valueResponse.Name,
      arn: valueResponse.ARN,
      versionId: valueResponse.VersionId,
      secretValue: reveal ? rawValue : REDACTED,
      versionStages: valueResponse.VersionStages,
      lastChanged: valueResponse.LastChangedDate,
      kmsKeyAlias,
    },
    ...(reveal ? {} : { suggestion: "Pass --reveal to show the actual secret value" }),
  };
}

async function runListSecrets(
  options: SecretsRunOptions,
): Promise<{ secretList: SecretsListResult } | Record<string, unknown>> {
  // Track whether --max-items was explicitly provided before extractMaxItems
  // returns the default — needed for the --query bypass check below.
  const explicitMaxItems = extractFlag(options.args, "--max-items") !== undefined;
  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");

  // Forward unknown flags verbatim (superset contract — e.g. --filters, --sort-order).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--max-items", "--next-token"], undefined, { service: "secretsmanager", operation: "list-secrets" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active and no explicit --max-items was given. Explicit --max-items is honored.
  const awsArgs: string[] = ["secretsmanager", "list-secrets"];
  if (!hasQuery || explicitMaxItems) {
    awsArgs.push("--max-items", String(maxItems));
  }
  if (nextTokenArg !== undefined) {
    awsArgs.push("--starting-token", nextTokenArg);
  }
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, toRunOpts(options));
  }

  const response = await awsJson<RawListSecretsResponse>(awsArgs, toRunOpts(options));
  const secrets = response.SecretList ?? [];
  const nextToken = response.NextToken;

  if (secrets.length === 0) {
    return {
      secretList: {
        secrets: [],
        count: "0 total",
        message: "No secrets found in this account/region",
        suggestion:
          'Create a secret with `aws secretsmanager create-secret --name <name> --secret-string <value>`',
      },
    };
  }

  // Bulk-resolve unique KMS key aliases in parallel
  const uniqueKeyIds = secrets
    .map((s) => s.KmsKeyId)
    .filter((k): k is string => k !== undefined && k !== "");
  const aliasMap = await resolveAliasMap(uniqueKeyIds, options);

  const projected: SecretsListEntry[] = secrets.map((s) => ({
    name: s.Name,
    arn: s.ARN,
    description: s.Description,
    rotationEnabled: s.RotationEnabled ?? false,
    lastChanged: s.LastChangedDate,
    lastRotated: s.LastRotatedDate,
    kmsKeyAlias:
      s.KmsKeyId !== undefined ? (aliasMap.get(s.KmsKeyId) ?? undefined) : undefined,
  }));

  return {
    secretList: {
      secrets: projected,
      count: countString(projected.length, nextToken),
      ...(nextToken !== undefined ? { nextToken } : {}),
    },
  };
}

async function runDescribeSecret(
  options: SecretsRunOptions,
): Promise<{ secretDetail: SecretsDetailResult } | Record<string, unknown>> {
  const positionals = extractPositionals(options.args, SECRETS_BOOL_FLAGS);
  const secretId =
    extractFlag(options.args, "--secret-id") ?? positionals[0];

  if (secretId === undefined || secretId === "") {
    throw new AxiError(
      "describe-secret requires a secret name or ARN",
      "USAGE_ERROR",
      [
        "Usage: aws-axi secretsmanager describe-secret <id>",
        "Or: aws-axi secretsmanager describe-secret --secret-id <id>",
      ],
    );
  }

  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--secret-id"], undefined, { service: "secretsmanager", operation: "describe-secret" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(
      ["secretsmanager", "describe-secret", "--secret-id", secretId, ...passthrough],
      toRunOpts(options),
    );
  }

  const response = await awsJson<RawDescribeSecretResponse>(
    ["secretsmanager", "describe-secret", "--secret-id", secretId, ...passthrough],
    toRunOpts(options),
  );

  const kmsKeyAlias =
    response.KmsKeyId !== undefined
      ? await resolveAlias(response.KmsKeyId, options)
      : undefined;

  return {
    secretDetail: {
      name: response.Name,
      arn: response.ARN,
      description: response.Description,
      rotationEnabled: response.RotationEnabled ?? false,
      lastChanged: response.LastChangedDate,
      lastRotated: response.LastRotatedDate,
      kmsKeyAlias,
    },
  };
}

// ─── secretsRun ───────────────────────────────────────────────────────────────

/**
 * Core Secrets Manager logic — testable without the CLI layer.
 *
 * Dispatches to the appropriate sub-operation based on options.subcommand.
 * Empty subcommand defaults to list-secrets.
 */
export async function secretsRun(
  options: SecretsRunOptions,
): Promise<SecretsRunResult> {
  switch (options.subcommand) {
    case "list-secrets":
    case "": // default
      return runListSecrets(options);
    case "get-secret-value":
      return runGetSecretValue(options);
    case "describe-secret":
      return runDescribeSecret(options);
    default:
      throw new AxiError(
        `Unknown secretsmanager subcommand: ${options.subcommand}`,
        "USAGE_ERROR",
        [
          "Valid subcommands: list-secrets, get-secret-value, describe-secret",
          "Run `aws-axi secretsmanager --help` for full usage",
        ],
      );
  }
}

// ─── secretsCommand ───────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter.
 *
 * Parses the first arg as the subcommand (defaulting to list-secrets when
 * absent or a flag), dispatches to secretsRun, and wraps the result under
 * a top-level `secretsmanager` key for TOON rendering by the CLI layer.
 *
 * Used for both the `secretsmanager` command and the `secrets` alias.
 */
export async function secretsCommand(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const firstArg = args[0] ?? "";

  let subcommand: string;
  let remainingArgs: string[];

  if (firstArg === "" || firstArg.startsWith("--")) {
    subcommand = "list-secrets";
    remainingArgs = args.filter((a) => a !== "");
  } else if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    subcommand = firstArg;
    remainingArgs = args.slice(1);
  } else {
    // Not in the overlay's hot-path — delegate to the model-driven engine.
    // The engine validates against the botocore secretsmanager model and surfaces
    // a clean USAGE_ERROR for ops that are genuinely unknown to AWS.
    return fallThroughToEngine("secretsmanager", firstArg, args.slice(1), context);
  }

  const result = await secretsRun({ subcommand, args: remainingArgs, context });
  return { secretsmanager: result };
}
