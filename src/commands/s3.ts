/**
 * `aws-axi s3` — S3 overlay: ls / cp / rm / head-object / create-bucket.
 *
 * Design choices:
 *   - ls (no URI)    → s3api list-buckets          (JSON)
 *   - ls s3://…      → s3api list-objects-v2        (JSON, capped at S3_PAGE_SIZE)
 *   - cp / rm        → s3 high-level verbs          (text; --output json ignored by aws s3)
 *   - head-object    → s3api head-object            (JSON)
 *   - create-bucket  → s3api create-bucket          (JSON, idempotent: BucketAlreadyOwnedByYou = success)
 *
 * Exported shapes:
 *   s3LsRun(options)            → S3LsResult
 *   s3HeadObjectRun(options)    → S3HeadObjectResult
 *   s3CreateBucketRun(options)  → S3CreateBucketResult
 *   s3CpRun(options)            → S3CpResult
 *   s3RmRun(options)            → S3RmResult
 *   s3Command(args, context)    → AxiCliCommand adapter
 *   S3_PAGE_SIZE                → pagination cap constant
 *   S3_HELP                     → help text
 */
import { AxiError } from "axi-sdk-js";
import { awsJson, awsRaw, awsExec } from "../aws.js";
import type { AwsContext } from "../context.js";
import { parseAwsError } from "../errors.js";
import { fallThroughToEngine } from "../engine.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum objects returned per s3 ls page. */
export const S3_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Query the region the `aws` CLI would use for the active profile by calling
 * `aws configure get region`. This reads the profile's config-file entry —
 * NOT the env-var region (which context.region already captures).
 *
 * Returns the trimmed region string, or `undefined` if not configured or if
 * the command fails.
 *
 * Used by `s3CreateBucketRun` to resolve the LocationConstraint when no
 * --region flag or AWS_REGION/AWS_DEFAULT_REGION env var is present, which
 * is the normal `aws configure` setup.
 */
async function resolveConfigRegion(opts: {
  readonly binary?: string;
  readonly context?: AwsContext;
}): Promise<string | undefined> {
  // Pass context so AWS_PROFILE is injected, but region injection is skipped
  // (context.region is undefined at this call site by construction).
  const result = await awsRaw(
    ["configure", "get", "region"],
    { binary: opts.binary, context: opts.context },
  );

  if (result.exitCode === 0) {
    const region = result.stdout.trim();
    if (region.length > 0) {
      return region;
    }
  }
  return undefined;
}

function parseFlag(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Parse an S3 URI of the form `s3://bucket` or `s3://bucket/prefix/`.
 * Throws USAGE_ERROR if the URI is not a valid S3 URI.
 */
function parseS3Uri(uri: string): { readonly bucket: string; readonly prefix: string } {
  if (!uri.startsWith("s3://")) {
    throw new AxiError(
      `Invalid S3 URI "${uri}" — must start with s3://`,
      "USAGE_ERROR",
      ["Example: s3://my-bucket/prefix/"],
    );
  }
  const rest = uri.slice("s3://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) {
    return { bucket: rest, prefix: "" };
  }
  return {
    bucket: rest.slice(0, slashIdx),
    prefix: rest.slice(slashIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// Raw AWS response shapes (never exported — internal only)
// ---------------------------------------------------------------------------

interface AwsBucket {
  readonly Name: string;
  readonly CreationDate: string;
}

interface ListBucketsResponse {
  readonly Buckets?: readonly AwsBucket[];
  readonly Owner?: unknown;
}

interface AwsS3Object {
  readonly Key: string;
  readonly Size: number;
  readonly LastModified: string;
  readonly ETag: string;
  readonly StorageClass?: string;
}

interface ListObjectsV2Response {
  readonly Contents?: readonly AwsS3Object[];
  readonly KeyCount?: number;
  readonly MaxKeys?: number;
  readonly IsTruncated?: boolean;
  readonly NextToken?: string;
  readonly Name?: string;
  readonly Prefix?: string;
}

interface HeadObjectResponse {
  readonly ContentType?: string;
  readonly ContentLength?: number;
  readonly ETag?: string;
  readonly LastModified?: string;
  readonly Metadata?: Record<string, string>;
}

interface CreateBucketResponse {
  readonly Location?: string;
}

// ---------------------------------------------------------------------------
// s3LsRun — list buckets or list objects under a prefix
// ---------------------------------------------------------------------------

export interface S3LsBucketItem {
  readonly name: string;
  readonly creationDate: string;
}

export interface S3LsObjectItem {
  readonly key: string;
  readonly size: number;
  readonly lastModified: string;
  readonly etag?: string;
}

export interface S3LsResult {
  readonly buckets?: readonly S3LsBucketItem[];
  readonly objects?: readonly S3LsObjectItem[];
  readonly empty?: boolean;
  readonly truncated?: boolean;
  readonly nextToken?: string;
  readonly hint?: string;
}

export interface S3LsRunOptions {
  /**
   * Optional S3 URI (e.g. `s3://bucket/prefix/`). When absent the command
   * lists all buckets the caller can access.
   */
  readonly prefix?: string;
  /** Pagination continuation token from a previous truncated response. */
  readonly startingToken?: string;
  readonly binary?: string;
  readonly context?: AwsContext;
}

/**
 * List S3 buckets (no prefix) or objects under an S3 URI prefix (with cap).
 *
 * - No prefix → s3api list-buckets
 * - With prefix → s3api list-objects-v2, capped at S3_PAGE_SIZE with honest
 *   truncation reporting and a --starting-token continuation hint.
 */
export async function s3LsRun(options: S3LsRunOptions): Promise<S3LsResult> {
  // ── list all buckets ──────────────────────────────────────────────────────
  if (options.prefix === undefined) {
    const resp = await awsJson<ListBucketsResponse>(
      ["s3api", "list-buckets"],
      { binary: options.binary, context: options.context },
    );

    const rawBuckets = resp.Buckets ?? [];
    const buckets: S3LsBucketItem[] = rawBuckets.map((b) => ({
      name: b.Name,
      creationDate: b.CreationDate,
    }));

    if (buckets.length === 0) {
      return {
        buckets,
        empty: true,
        hint: "No buckets found. Create one with: aws-axi s3 create-bucket --bucket <name>",
      };
    }

    return { buckets };
  }

  // ── list objects under prefix ─────────────────────────────────────────────
  const { bucket, prefix } = parseS3Uri(options.prefix);

  const args: string[] = [
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--max-items",
    String(S3_PAGE_SIZE),
  ];
  if (prefix) {
    args.push("--prefix", prefix);
  }
  if (options.startingToken !== undefined) {
    args.push("--starting-token", options.startingToken);
  }

  const resp = await awsJson<ListObjectsV2Response>(args, {
    binary: options.binary,
    context: options.context,
  });

  const rawContents = resp.Contents ?? [];
  const objects: S3LsObjectItem[] = rawContents.map((c) => ({
    key: c.Key,
    size: c.Size,
    lastModified: c.LastModified,
    etag: c.ETag,
  }));

  // Truncated when S3 signals it OR when the CLI pagination token is present.
  const truncated = resp.IsTruncated === true || resp.NextToken !== undefined;

  if (objects.length === 0) {
    const displayPrefix = prefix || "(root)";
    return {
      objects,
      empty: true,
      truncated: false,
      hint: `No objects found under prefix "${displayPrefix}" in bucket "${bucket}". Try: aws-axi s3 ls s3://${bucket}/`,
    };
  }

  if (truncated) {
    return {
      objects,
      truncated: true,
      nextToken: resp.NextToken,
      hint: `Showing ${objects.length} objects (more available). Use --starting-token ${resp.NextToken ?? ""} to continue.`,
    };
  }

  return { objects, truncated: false };
}

// ---------------------------------------------------------------------------
// s3HeadObjectRun — object metadata
// ---------------------------------------------------------------------------

export interface S3HeadObjectResult {
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly metadata?: Record<string, string>;
}

export interface S3HeadObjectRunOptions {
  readonly bucket: string;
  readonly key: string;
  readonly binary?: string;
  readonly context?: AwsContext;
}

/**
 * Fetch S3 object metadata via `aws s3api head-object`.
 * Projects the raw response down to the load-bearing fields.
 */
export async function s3HeadObjectRun(
  options: S3HeadObjectRunOptions,
): Promise<S3HeadObjectResult> {
  const resp = await awsJson<HeadObjectResponse>(
    ["s3api", "head-object", "--bucket", options.bucket, "--key", options.key],
    { binary: options.binary, context: options.context },
  );

  return {
    contentType: resp.ContentType,
    contentLength: resp.ContentLength,
    etag: resp.ETag,
    lastModified: resp.LastModified,
    metadata: resp.Metadata,
  };
}

// ---------------------------------------------------------------------------
// s3CreateBucketRun — idempotent bucket creation
// ---------------------------------------------------------------------------

export interface S3CreateBucketResult {
  readonly created: boolean;
  readonly idempotent: boolean;
  readonly bucket: string;
  readonly location?: string;
}

export interface S3CreateBucketRunOptions {
  readonly bucket: string;
  /**
   * Explicit region for the bucket. When absent, uses the context region.
   * Note: us-east-1 does NOT accept a LocationConstraint.
   */
  readonly region?: string;
  readonly binary?: string;
  readonly context?: AwsContext;
}

/**
 * Create an S3 bucket, treating `BucketAlreadyOwnedByYou` as an idempotent
 * no-op success. Throws for `BucketAlreadyExists` (owned by someone else) and
 * all other errors.
 *
 * This implements "desired state" semantics: calling it twice with the same
 * bucket name is safe and returns a consistent result.
 */
export async function s3CreateBucketRun(
  options: S3CreateBucketRunOptions,
): Promise<S3CreateBucketResult> {
  const args: string[] = ["s3api", "create-bucket", "--bucket", options.bucket];

  // Resolve the effective region in priority order:
  //   1. Explicit --region option
  //   2. Context region (from --region argv flag or AWS_REGION/AWS_DEFAULT_REGION env)
  //   3. Profile config-file region (what the `aws` child process itself would use)
  //
  // We must determine this before calling create-bucket because:
  //   - us-east-1 must NOT include LocationConstraint (AWS API requirement)
  //   - all other regions MUST include it
  // Silently omitting it when the child targets a non-us-east-1 endpoint
  // (via the profile config) causes IllegalLocationConstraintException.
  let effectiveRegion: string | undefined = options.region ?? options.context?.region;

  if (effectiveRegion === undefined) {
    effectiveRegion = await resolveConfigRegion({
      binary: options.binary,
      context: options.context,
    });
  }

  if (effectiveRegion === undefined) {
    throw new AxiError(
      "Cannot determine bucket region: no --region flag, AWS_REGION/AWS_DEFAULT_REGION env var, or configured region in the active AWS profile.",
      "USAGE_ERROR",
      [
        "Pass --region <region> to specify the bucket region explicitly",
        "Or run: aws configure set region <region>",
        "Or run: aws configure set region <region> --profile <profile>",
      ],
    );
  }

  // us-east-1 must NOT include LocationConstraint — all other regions require it.
  if (effectiveRegion !== "us-east-1") {
    args.push(
      "--create-bucket-configuration",
      `LocationConstraint=${effectiveRegion}`,
    );
  }

  const result = await awsRaw(args, {
    binary: options.binary,
    context: options.context,
  });

  // ── success ───────────────────────────────────────────────────────────────
  if (result.exitCode === 0) {
    let location: string | undefined;
    try {
      const parsed = JSON.parse(result.stdout) as CreateBucketResponse;
      location = parsed.Location;
    } catch {
      // stdout may be empty on success in some CLI versions; not an error.
    }
    return {
      created: true,
      idempotent: false,
      bucket: options.bucket,
      location,
    };
  }

  // ── idempotent: bucket already owned by this caller ───────────────────────
  const parsed = parseAwsError(result.stderr, result.exitCode);
  if (parsed.botoCode === "BucketAlreadyOwnedByYou") {
    return {
      created: false,
      idempotent: true,
      bucket: options.bucket,
    };
  }

  // ── all other errors (BucketAlreadyExists, auth, etc.) ───────────────────
  throw new AxiError(parsed.message, parsed.code, [...parsed.suggestions]);
}

// ---------------------------------------------------------------------------
// s3CpRun — copy objects
// ---------------------------------------------------------------------------

export interface S3CpResult {
  readonly source: string;
  readonly destination: string;
  readonly dryRun: boolean;
}

export interface S3CpRunOptions {
  readonly source: string;
  readonly destination: string;
  /** Pass --dryrun to aws s3 cp to preview without mutating. */
  readonly dryRun?: boolean;
  readonly binary?: string;
  readonly context?: AwsContext;
}

/**
 * Copy an S3 object via the `aws s3 cp` high-level command.
 * The high-level command produces text output; `--output json` is accepted by
 * the global parser but does not change the output format for s3 verbs.
 * Supports `--dryrun` for safe permission preview.
 */
export async function s3CpRun(options: S3CpRunOptions): Promise<S3CpResult> {
  const args: string[] = ["s3", "cp", options.source, options.destination];
  if (options.dryRun === true) {
    args.push("--dryrun");
  }

  await awsExec(args, { binary: options.binary, context: options.context });

  return {
    source: options.source,
    destination: options.destination,
    dryRun: options.dryRun ?? false,
  };
}

// ---------------------------------------------------------------------------
// s3RmRun — remove objects
// ---------------------------------------------------------------------------

export interface S3RmResult {
  readonly target: string;
  readonly dryRun: boolean;
}

export interface S3RmRunOptions {
  readonly target: string;
  /** Pass --dryrun to aws s3 rm to preview without mutating. */
  readonly dryRun?: boolean;
  readonly binary?: string;
  readonly context?: AwsContext;
}

/**
 * Remove an S3 object via the `aws s3 rm` high-level command.
 * Supports `--dryrun` for safe permission preview.
 */
export async function s3RmRun(options: S3RmRunOptions): Promise<S3RmResult> {
  const args: string[] = ["s3", "rm", options.target];
  if (options.dryRun === true) {
    args.push("--dryrun");
  }

  await awsExec(args, { binary: options.binary, context: options.context });

  return {
    target: options.target,
    dryRun: options.dryRun ?? false,
  };
}

// ---------------------------------------------------------------------------
// s3Command — AxiCliCommand adapter
// ---------------------------------------------------------------------------

export const S3_HELP = `usage: aws-axi s3 <operation> [args] [flags]
operations[5] (enriched overlays):
  ls, cp, rm, head-object, create-bucket
  (any other s3 operation falls through to the generic engine — run \`aws s3 help\` to list all)
flags[4]:
  --profile <name>, --region <region>, --dryrun (cp/rm), --starting-token <tok> (ls)
examples:
  aws-axi s3 ls
  aws-axi s3 ls s3://my-bucket/prefix/
  aws-axi s3 ls s3://my-bucket/ --starting-token TOKEN
  aws-axi s3 head-object --bucket my-bucket --key path/to/file.txt
  aws-axi s3 cp s3://src-bucket/file.txt s3://dst-bucket/file.txt
  aws-axi s3 cp s3://src-bucket/file.txt /tmp/file.txt --dryrun
  aws-axi s3 rm s3://my-bucket/old-file.txt
  aws-axi s3 rm s3://my-bucket/old-file.txt --dryrun
  aws-axi s3 create-bucket --bucket my-bucket
  aws-axi s3 create-bucket --bucket my-bucket --region eu-west-1
`;

/**
 * AxiCliCommand adapter for the s3 overlay.
 * Args are pre-stripped of --profile/--region by the CLI wrapper.
 * Dispatches to the appropriate run function and returns the result as a plain
 * record for axi-sdk-js / TOON encoding.
 */
export async function s3Command(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "ls": {
      const prefix = rest.find((a) => a.startsWith("s3://"));
      const startingToken = parseFlag(rest, "--starting-token");
      const result = await s3LsRun({ prefix, startingToken, context });
      return result as unknown as Record<string, unknown>;
    }

    case "cp": {
      const positionals = rest.filter((a) => !a.startsWith("-"));
      const source = positionals[0];
      const destination = positionals[1];
      if (source === undefined || destination === undefined) {
        throw new AxiError(
          "s3 cp requires <source> and <destination>",
          "USAGE_ERROR",
          ["Usage: aws-axi s3 cp <source> <destination> [--dryrun]"],
        );
      }
      const dryRun = hasFlag(rest, "--dryrun");
      const result = await s3CpRun({ source, destination, dryRun, context });
      return result as unknown as Record<string, unknown>;
    }

    case "rm": {
      const positionals = rest.filter((a) => !a.startsWith("-"));
      const target = positionals[0];
      if (target === undefined) {
        throw new AxiError(
          "s3 rm requires a <target> S3 URI",
          "USAGE_ERROR",
          ["Usage: aws-axi s3 rm s3://bucket/key [--dryrun]"],
        );
      }
      const dryRun = hasFlag(rest, "--dryrun");
      const result = await s3RmRun({ target, dryRun, context });
      return result as unknown as Record<string, unknown>;
    }

    case "head-object": {
      const bucket = parseFlag(rest, "--bucket");
      const key = parseFlag(rest, "--key");
      if (bucket === undefined || key === undefined) {
        throw new AxiError(
          "s3 head-object requires --bucket and --key",
          "USAGE_ERROR",
          ["Usage: aws-axi s3 head-object --bucket <name> --key <key>"],
        );
      }
      const result = await s3HeadObjectRun({ bucket, key, context });
      return result as unknown as Record<string, unknown>;
    }

    case "create-bucket": {
      const bucket = parseFlag(rest, "--bucket");
      if (bucket === undefined) {
        throw new AxiError(
          "s3 create-bucket requires --bucket",
          "USAGE_ERROR",
          ["Usage: aws-axi s3 create-bucket --bucket <name> [--region <region>]"],
        );
      }
      const region = parseFlag(rest, "--region");
      const result = await s3CreateBucketRun({ bucket, region, context });
      return result as unknown as Record<string, unknown>;
    }

    default: {
      // Not in the overlay's hot-path — delegate to the model-driven engine.
      // The engine validates against the botocore s3 model and surfaces a clean
      // USAGE_ERROR for ops that are genuinely unknown to AWS.
      return fallThroughToEngine("s3", subcommand ?? "", args.slice(1), context);
    }
  }
}
