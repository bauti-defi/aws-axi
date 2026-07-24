/**
 * `resolve-bucket` — reusable S3 bucket existence + accessibility primitive.
 *
 * Calls `aws s3api head-bucket` to determine whether the caller has access
 * to a given bucket. The result is cached for the lifetime of the process
 * (fine for a CLI; each invocation is short-lived).
 *
 * Three outcomes:
 *   exists=true   — bucket is accessible to the caller
 *   exists=false  — bucket does not exist (NoSuchBucket / 404)
 *   throws        — any other error (AccessDenied, no credentials, etc.)
 *
 * Exported:
 *   resolveBucket(options) → BucketInfo
 */
import { AxiError } from "axi-sdk-js";
import { awsRaw } from "../aws.js";
import type { AwsContext } from "../context.js";

export interface BucketInfo {
  readonly exists: boolean;
}

export interface ResolveBucketOptions {
  readonly bucket: string;
  readonly binary?: string;
  readonly context?: AwsContext;
  /**
   * Override path to ~/.aws/config for NO_PROFILE_SELECTED diagnostics.
   * Defaults to the real ~/.aws/config. Injectable for tests so they never
   * read the developer's actual config file.
   */
  readonly configPath?: string;
}

// Process-scoped cache — keyed by profile:region:bucket.
// A CLI process is short-lived so a simple Map is sufficient.
const cache = new Map<string, BucketInfo>();

function cacheKey(options: ResolveBucketOptions): string {
  const profile = options.context?.profile ?? "";
  const region = options.context?.region ?? "";
  return `${profile}:${region}:${options.bucket}`;
}

// Botocore codes that mean "the bucket does not exist".
// NoSuchKey is intentionally excluded — head-bucket never emits it.
const NOT_FOUND_CODES = new Set(["NoSuchBucket", "404"]);

/**
 * Resolve whether a bucket exists and is accessible to the current caller.
 *
 * Result is memoised in a process-level cache keyed on profile+region+bucket.
 * Throws AxiError for any non–not-found error (e.g. AccessDenied, expired token).
 */
export async function resolveBucket(
  options: ResolveBucketOptions,
): Promise<BucketInfo> {
  const key = cacheKey(options);
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }

  const result = await awsRaw(
    ["s3api", "head-bucket", "--bucket", options.bucket],
    { binary: options.binary, context: options.context, configPath: options.configPath },
  );

  if (result.exitCode === 0) {
    const info: BucketInfo = { exists: true };
    cache.set(key, info);
    return info;
  }

  // awsRaw guarantees result.error is set for every non-zero exit. Guard
  // against undefined defensively (unreachable today) to keep the type
  // narrowing sound without a non-null assertion.
  if (result.error === undefined) {
    throw new AxiError("Unexpected non-zero exit with no error descriptor", "UNKNOWN");
  }

  // Handle "bucket does not exist" as a known non-error state.
  if (result.error.botoCode !== undefined && NOT_FOUND_CODES.has(result.error.botoCode)) {
    const info: BucketInfo = { exists: false };
    cache.set(key, info);
    return info;
  }

  // Propagate everything else as a structured error.
  throw new AxiError(result.error.message, result.error.code, [...result.error.suggestions]);
}
