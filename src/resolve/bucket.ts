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
import { parseAwsError } from "../errors.js";

export interface BucketInfo {
  readonly exists: boolean;
}

export interface ResolveBucketOptions {
  readonly bucket: string;
  readonly binary?: string;
  readonly context?: AwsContext;
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
    { binary: options.binary, context: options.context },
  );

  if (result.exitCode === 0) {
    const info: BucketInfo = { exists: true };
    cache.set(key, info);
    return info;
  }

  const parsed = parseAwsError(result.stderr, result.exitCode);

  // Handle "bucket does not exist" as a known non-error state.
  if (parsed.botoCode !== undefined && NOT_FOUND_CODES.has(parsed.botoCode)) {
    const info: BucketInfo = { exists: false };
    cache.set(key, info);
    return info;
  }

  // Propagate everything else as a structured error.
  throw new AxiError(parsed.message, parsed.code, [...parsed.suggestions]);
}
