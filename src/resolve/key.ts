/**
 * resolve-key — shared primitive: given any KMS key identifier (keyId, ARN,
 * or alias), return the canonical (keyId, ARN, primaryAlias) triple.
 *
 * Consumed by:
 *   - kms.ts (describe-key, list-keys alias enrichment)
 *   - Lambda, RDS, DynamoDB, Secrets Manager, SSM output enrichment (§4.3)
 *
 * Two exported surfaces:
 *   loadAliasMap(options)   — bulk-loads all aliases; cached per binary+profile+region
 *   resolveKey(input, opt)  — resolves one key; calls describe-key + list-aliases
 */
import type { AwsContext } from "../context.js";
import type { AwsRunOptions } from "../aws.js";
import { awsJson } from "../aws.js";

// ─── Raw AWS response shapes ──────────────────────────────────────────────────

interface RawKmsKeyMetadata {
  readonly KeyId: string;
  readonly Arn: string;
  readonly KeyState: string;
  readonly Enabled: boolean;
  readonly Description: string;
  readonly KeyManager: string;
  readonly KeyUsage: string;
  readonly KeySpec: string;
}

interface RawDescribeKeyResponse {
  readonly KeyMetadata: RawKmsKeyMetadata;
}

export interface RawKmsAlias {
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

// ─── Public shapes ────────────────────────────────────────────────────────────

export interface ResolvedKey {
  readonly keyId: string;
  readonly arn: string;
  /** Primary alias name (e.g. "alias/my-key"), undefined if none. */
  readonly alias: string | undefined;
}

export interface ResolveKeyOptions {
  /** Override the aws binary — for testing via real stub scripts. */
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ─── In-process alias map cache ───────────────────────────────────────────────
//
// Keyed by "<binary>:<profile>:<region>" so test stubs with unique binary
// paths never share cache entries. Alias lists are small in practice; caching
// the map within a process prevents redundant API calls during list-keys
// enrichment where every key needs the same alias map.

const aliasMapCache = new Map<string, ReadonlyMap<string, string>>();

function aliasCacheKey(options: ResolveKeyOptions): string {
  return [
    options.binary ?? "",
    options.context?.profile ?? "",
    options.context?.region ?? "",
  ].join(":");
}

function toRunOpts(options: ResolveKeyOptions): AwsRunOptions {
  return { binary: options.binary, context: options.context };
}

/**
 * Load all KMS aliases and return an immutable Map<keyId, primaryAliasName>.
 *
 * Entries with no TargetKeyId (AWS-managed service keys not yet associated
 * with a specific resource) are excluded. When multiple aliases point to the
 * same key, only the first encountered is retained.
 *
 * Cached per (binary, profile, region) for the lifetime of the process.
 */
export async function loadAliasMap(
  options: ResolveKeyOptions,
): Promise<ReadonlyMap<string, string>> {
  const cacheKey = aliasCacheKey(options);
  const hit = aliasMapCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const response = await awsJson<RawListAliasesResponse>(
    ["kms", "list-aliases"],
    toRunOpts(options),
  );

  const map = new Map<string, string>();
  for (const alias of response.Aliases) {
    if (
      alias.TargetKeyId !== undefined &&
      alias.TargetKeyId !== "" &&
      !map.has(alias.TargetKeyId)
    ) {
      map.set(alias.TargetKeyId, alias.AliasName);
    }
  }

  aliasMapCache.set(cacheKey, map);
  return map;
}

/**
 * Resolve a KMS key identifier (keyId, ARN, or alias) to its canonical
 * ResolvedKey (keyId, ARN, primary alias).
 *
 * `aws kms describe-key --key-id` accepts all four identifier forms:
 *   - UUID key id:    1234abcd-12ab-34cd-56ef-1234567890ab
 *   - Key ARN:        arn:aws:kms:…:key/…
 *   - Alias name:     alias/my-key
 *   - Alias ARN:      arn:aws:kms:…:alias/my-key
 *
 * Throws AxiError (SERVICE_CLIENT_ERROR) when the key does not exist or
 * access is denied — propagated from awsJson's error mapping.
 */
export async function resolveKey(
  input: string,
  options: ResolveKeyOptions,
): Promise<ResolvedKey> {
  const runOpts = toRunOpts(options);

  const describeResult = await awsJson<RawDescribeKeyResponse>(
    ["kms", "describe-key", "--key-id", input],
    runOpts,
  );

  const meta = describeResult.KeyMetadata;

  const aliasResponse = await awsJson<RawListAliasesResponse>(
    ["kms", "list-aliases", "--key-id", meta.KeyId],
    runOpts,
  );

  const primaryAlias = aliasResponse.Aliases[0]?.AliasName;

  return {
    keyId: meta.KeyId,
    arn: meta.Arn,
    alias: primaryAlias,
  };
}
