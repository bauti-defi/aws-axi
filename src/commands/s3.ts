/**
 * `aws-axi s3` — S3 overlay: ls / cp / rm / head-object / create-bucket.
 *
 * Design choices:
 *   - ls (no URI)    → s3api list-buckets          (JSON, capped at S3_PAGE_SIZE; bypass with --query)
 *   - ls s3://…      → s3api list-objects-v2        (JSON, capped at S3_PAGE_SIZE; bypass with --query)
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
import { collectPassthroughFlags, buildPassthrough } from "../overlay-args.js";

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
 * Remove the first occurrence of each `positional` value from `args`.
 *
 * Used to strip already-identified positionals (source, destination, target)
 * before calling `collectPassthroughFlags`. Once positionals are removed, every
 * remaining bare token can only be a flag value — the heuristic is then safe and
 * never accidentally eats a positional as a boolean flag's value.
 */
function stripPositionals(args: readonly string[], ...positionals: (string | undefined)[]): string[] {
  const remaining = [...args];
  for (const pos of positionals) {
    if (pos === undefined) continue;
    const idx = remaining.indexOf(pos);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  return remaining;
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
  /**
   * Botocore-synthesized pagination token. Present only when --max-items
   * truncates the result. The underlying ListBuckets paginator uses
   * ContinuationToken as its native input/output token, but the aws CLI
   * strips it and emits this synthesized NextToken instead (engine.ts
   * contract: NEVER gate truncation on native flags).
   */
  readonly NextToken?: string;
}

interface AwsS3Object {
  readonly Key: string;
  readonly Size: number;
  readonly LastModified: string;
  readonly ETag: string;
  readonly StorageClass?: string;
}

interface AwsCommonPrefix {
  readonly Prefix: string;
}

interface ListObjectsV2Response {
  readonly Contents?: readonly AwsS3Object[];
  /** Present when --delimiter is used: groups objects sharing a common prefix. */
  readonly CommonPrefixes?: readonly AwsCommonPrefix[];
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

/** A common-prefix entry ("folder") returned by list-objects-v2 with --delimiter /. */
export interface S3LsPrefixItem {
  readonly prefix: string;
}

export interface S3LsResult {
  readonly buckets?: readonly S3LsBucketItem[];
  /** Common prefixes ("folders") returned when --delimiter / is active. */
  readonly prefixes?: readonly S3LsPrefixItem[];
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
  /** Unknown flags to forward verbatim to the underlying aws invocation. */
  readonly passthrough?: readonly string[];
  /**
   * True when --query was present in the caller's args. When set, the overlay
   * bypasses its curated projection (aws CLI applies JMESPath before we see the
   * response; the shape is unknown).
   */
  readonly hasQuery?: boolean;
  /**
   * When true, list-objects-v2 is called WITHOUT --delimiter /, returning all
   * nested objects recursively. Default (false/undefined) adds --delimiter / to
   * match real `aws s3 ls` non-recursive behavior (groups by common prefix).
   */
  readonly recursive?: boolean;
  readonly binary?: string;
  readonly context?: AwsContext;
}

/**
 * List S3 buckets (no prefix) or objects under an S3 URI prefix (with cap).
 *
 * - No prefix → s3api list-buckets, capped at S3_PAGE_SIZE with honest
 *   truncation reporting and a --starting-token continuation hint.
 * - With prefix → s3api list-objects-v2, capped at S3_PAGE_SIZE with honest
 *   truncation reporting and a --starting-token continuation hint.
 */
export async function s3LsRun(
  options: S3LsRunOptions,
): Promise<S3LsResult | Record<string, unknown>> {
  // ── list all buckets ──────────────────────────────────────────────────────
  if (options.prefix === undefined) {
    // s3api list-buckets is a genuine paginated operation. The botocore
    // ListBuckets paginator uses ContinuationToken as both input and output
    // token (botocore model), but the aws CLI strips that field from the
    // response — truncation surfaces only as a synthesized NextToken under
    // --max-items (engine.ts pagination contract). Cap at S3_PAGE_SIZE to
    // bound the TOON blast; forward --starting-token when the caller resumes.
    //
    // --query bypass: when --query is active, JMESPath projects NextToken away,
    // which would cause silent truncation at S3_PAGE_SIZE. The caller opted
    // out of the overlay's curation — skip the cap too. Without --max-items,
    // botocore auto-pages the complete result (same semantics as real `aws`).
    const lsBucketsArgs: string[] = ["s3api", "list-buckets"];
    if (options.hasQuery !== true) {
      lsBucketsArgs.push("--max-items", String(S3_PAGE_SIZE));
    }
    if (options.startingToken !== undefined) {
      lsBucketsArgs.push("--starting-token", options.startingToken);
    }
    if (options.passthrough !== undefined) {
      lsBucketsArgs.push(...options.passthrough);
    }
    if (options.hasQuery === true) {
      // --query: aws CLI applies JMESPath; bypass curated projection and page cap.
      // Without --max-items, botocore auto-pages to the complete result (all pages).
      return awsJson<Record<string, unknown>>(lsBucketsArgs, {
        binary: options.binary,
        context: options.context,
      });
    }
    const resp = await awsJson<ListBucketsResponse>(
      lsBucketsArgs,
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

    // Gate truncation ONLY on the botocore-synthesized NextToken — the engine.ts
    // contract. ContinuationToken is stripped by the --max-items paginator and
    // never appears in the child's stdout; gating on it would be dead code.
    if (resp.NextToken !== undefined) {
      return {
        buckets,
        truncated: true,
        nextToken: resp.NextToken,
        hint: `Showing ${buckets.length} buckets (more available). Use --starting-token ${resp.NextToken} to continue.`,
      };
    }

    return { buckets };
  }

  // ── list objects under prefix ─────────────────────────────────────────────
  const { bucket, prefix } = parseS3Uri(options.prefix);

  // --query bypass: same reasoning as the buckets path — JMESPath projects
  // NextToken away, so the cap would cause silent truncation when --query is active.
  // Skip --max-items in that case; botocore auto-pages the complete result.
  const args: string[] = [
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
  ];
  if (options.hasQuery !== true) {
    args.push("--max-items", String(S3_PAGE_SIZE));
  }
  if (prefix) {
    args.push("--prefix", prefix);
  }
  // Add --delimiter / by default to match real `aws s3 ls` non-recursive behavior.
  // Without a delimiter, list-objects-v2 returns ALL nested keys (recursive). With
  // --delimiter /, S3 groups keys sharing a common prefix into CommonPrefixes ("folders").
  // When recursive=true the caller explicitly wants all nested keys; skip the delimiter.
  if (options.recursive !== true) {
    args.push("--delimiter", "/");
  }
  if (options.startingToken !== undefined) {
    args.push("--starting-token", options.startingToken);
  }
  if (options.passthrough !== undefined) {
    args.push(...options.passthrough);
  }

  if (options.hasQuery === true) {
    // --query: aws CLI applies JMESPath; bypass curated projection and page cap.
    // Without --max-items, botocore auto-pages to the complete result (all pages).
    return awsJson<Record<string, unknown>>(args, {
      binary: options.binary,
      context: options.context,
    });
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

  // Map CommonPrefixes ("folder" entries) returned when --delimiter is set.
  // Folder-only buckets have empty Contents but non-empty CommonPrefixes;
  // they must NOT be reported as empty.
  const prefixes: S3LsPrefixItem[] = (resp.CommonPrefixes ?? []).map((cp) => ({
    prefix: cp.Prefix,
  }));

  // Truncated when S3 signals it OR when the CLI pagination token is present.
  const truncated = resp.IsTruncated === true || resp.NextToken !== undefined;

  const totalItems = objects.length + prefixes.length;
  if (totalItems === 0) {
    const displayPrefix = prefix || "(root)";
    return {
      objects,
      prefixes,
      empty: true,
      truncated: false,
      hint: `No objects found under prefix "${displayPrefix}" in bucket "${bucket}". Try: aws-axi s3 ls s3://${bucket}/`,
    };
  }

  if (truncated) {
    return {
      objects,
      prefixes,
      truncated: true,
      nextToken: resp.NextToken,
      hint: `Showing ${totalItems} items (more available). Use --starting-token ${resp.NextToken ?? ""} to continue.`,
    };
  }

  return { objects, prefixes, truncated: false };
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
  /** Unknown flags to forward verbatim (e.g. --version-id). */
  readonly passthrough?: readonly string[];
  /**
   * When true the caller passed --query; the aws CLI applies JMESPath and the
   * response shape is unknown. Skip curated projection and return the raw result.
   */
  readonly hasQuery?: boolean;
  readonly binary?: string;
  readonly context?: AwsContext;
}

/**
 * Fetch S3 object metadata via `aws s3api head-object`.
 * Projects the raw response down to the load-bearing fields.
 * When hasQuery is true the overlay bypasses projection so JMESPath output
 * flows through unmodified.
 */
export async function s3HeadObjectRun(
  options: S3HeadObjectRunOptions,
): Promise<S3HeadObjectResult | Record<string, unknown>> {
  const headArgs = [
    "s3api", "head-object",
    "--bucket", options.bucket,
    "--key", options.key,
    ...(options.passthrough ?? []),
  ];

  if (options.hasQuery) {
    // --query present: aws CLI applies JMESPath before we see the response.
    // The result shape is unknown — skip curated projection and return raw.
    return awsJson<Record<string, unknown>>(headArgs, { binary: options.binary, context: options.context });
  }

  const resp = await awsJson<HeadObjectResponse>(headArgs, { binary: options.binary, context: options.context });

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
  /** Unknown flags to forward verbatim to the underlying aws invocation. */
  readonly passthrough?: readonly string[];
  /**
   * When true the caller passed --query; skip synthesized result and return
   * the raw aws CLI output so JMESPath projection flows through unmodified.
   */
  readonly hasQuery?: boolean;
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
): Promise<S3CreateBucketResult | Record<string, unknown>> {
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

  if (options.passthrough !== undefined) {
    args.push(...options.passthrough);
  }

  if (options.hasQuery) {
    // --query present: aws CLI applies JMESPath before we see the response.
    // Switch to awsJson so --output json is appended and result is parsed;
    // skip the synthesized S3CreateBucketResult projection.
    return awsJson<Record<string, unknown>>(args, { binary: options.binary, context: options.context });
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
  /** Unknown flags to forward verbatim (e.g. --sse, --sse-kms-key-id, --storage-class). */
  readonly passthrough?: readonly string[];
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
  if (options.passthrough !== undefined) {
    args.push(...options.passthrough);
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
  /** Unknown flags to forward verbatim (e.g. --recursive, --exclude, --include). */
  readonly passthrough?: readonly string[];
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
  if (options.passthrough !== undefined) {
    args.push(...options.passthrough);
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

Any flag accepted by the underlying \`aws s3\` or \`aws s3api\` operation is
forwarded verbatim — overlays never restrict the input contract, only enrich
the output.

operations[5] (enriched overlays):
  ls, cp, rm, head-object, create-bucket
  (any other s3 operation falls through to the generic engine — run \`aws s3 help\` to list all)

flags (overlay-specific):
  --profile <name>        AWS profile (inherited from global --profile)
  --region <region>       AWS region  (inherited from global --region)
  --dryrun                Preview without mutating (cp/rm)
  --starting-token <tok>  Resume a paginated ls call (both paths: list-buckets and list-objects-v2).
                          ls is capped at 20 items per page; when more are available, truncated: true
                          and nextToken are emitted. Pass nextToken as --starting-token to continue.
                          Use --query to bypass the cap: output is unbounded (botocore auto-pages all
                          results), but nextToken is projected away so pagination state is not surfaced.

examples:
  aws-axi s3 ls
  aws-axi s3 ls --starting-token TOKEN              # resume a paginated list-buckets call
  aws-axi s3 ls s3://my-bucket/prefix/
  aws-axi s3 ls s3://my-bucket/ --starting-token TOKEN
  aws-axi s3 head-object --bucket my-bucket --key path/to/file.txt
  aws-axi s3 head-object --bucket b --key k --version-id v1   # forwarded to aws
  aws-axi s3 cp s3://src-bucket/file.txt s3://dst-bucket/file.txt
  aws-axi s3 cp /tmp/f.txt s3://b/f.txt --sse aws:kms         # forwarded to aws
  aws-axi s3 cp s3://src-bucket/file.txt /tmp/file.txt --dryrun
  aws-axi s3 rm s3://my-bucket/old-file.txt
  aws-axi s3 rm s3://my-bucket/prefix/ --recursive            # forwarded to aws
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
      // ── Cross-path display-only flags (invalid on both list-buckets and list-objects-v2) ─
      // Forwarding these verbatim would cause the s3api child to exit 252 with an
      // opaque "Unknown options" message. Deliberate exception to the superset
      // invariant: these are display-formatting flags that aws-axi handles in its
      // own output layer; silently absorbing them would let an agent believe it
      // received human-readable sizes when it did not.
      if (hasFlag(rest, "--human-readable")) {
        throw new AxiError(
          "--human-readable is a display-only aws s3 ls flag with no s3api equivalent; aws-axi reports size as a plain integer",
          "USAGE_ERROR",
          ["Remove --human-readable — aws-axi reports size as a plain integer"],
        );
      }
      if (hasFlag(rest, "--summarize")) {
        throw new AxiError(
          "--summarize is a display-only aws s3 ls flag with no s3api equivalent",
          "USAGE_ERROR",
          [
            "Remove --summarize",
            "To count objects: aws-axi s3 ls s3://bucket/ --query 'length(Contents)'",
          ],
        );
      }

      const prefix = rest.find((a) => a.startsWith("s3://"));
      const startingToken = parseFlag(rest, "--starting-token");

      if (prefix === undefined) {
        // ── No-URI path → s3api list-buckets ──────────────────────────────────
        // Intercept flags that only apply to the object-listing (prefix) path.
        if (hasFlag(rest, "--recursive")) {
          throw new AxiError(
            "--recursive requires a s3:// URI; it is not valid when listing all buckets",
            "USAGE_ERROR",
            ["To list objects recursively: aws-axi s3 ls s3://bucket/ --recursive"],
          );
        }
        if (hasFlag(rest, "--request-payer")) {
          throw new AxiError(
            "--request-payer is only valid when listing objects (s3:// URI path); it is not accepted by s3api list-buckets",
            "USAGE_ERROR",
            ["--request-payer is valid for: aws-axi s3 ls s3://bucket/ --request-payer requester"],
          );
        }

        // --bucket-name-prefix (aws s3 ls flag) → --prefix (list-buckets parameter).
        // The aws s3 ls flag name differs from the underlying s3api parameter name;
        // forwarding it verbatim causes list-buckets to exit 252 "Unknown options".
        const bucketNamePrefix = parseFlag(rest, "--bucket-name-prefix");

        const argsForPassthrough = stripPositionals(rest);
        // --bucket-region is a valid list-buckets filter; forward it via passthrough.
        // --starting-token and --bucket-name-prefix are owned (the latter is translated).
        const rawPassthrough = collectPassthroughFlags(
          argsForPassthrough,
          ["--starting-token", "--bucket-name-prefix"],
        );
        // Inject the translated --prefix for --bucket-name-prefix.
        const translatedPassthrough = bucketNamePrefix !== undefined
          ? [...rawPassthrough, "--prefix", bucketNamePrefix]
          : rawPassthrough;
        const { passthrough, hasQuery } = buildPassthrough(translatedPassthrough);
        const result = await s3LsRun({ startingToken, passthrough, hasQuery, context });
        return result as unknown as Record<string, unknown>;
      }

      // ── Prefix path → s3api list-objects-v2 ─────────────────────────────────
      // Intercept flags that only apply to the bucket-listing (no-URI) path.
      if (hasFlag(rest, "--bucket-name-prefix")) {
        throw new AxiError(
          "--bucket-name-prefix filters bucket names and is only valid when listing all buckets (no s3:// URI)",
          "USAGE_ERROR",
          [
            "To filter by key prefix, include it in the URI: aws-axi s3 ls s3://bucket/prefix/",
            "To filter buckets by name: aws-axi s3 ls --bucket-name-prefix foo",
          ],
        );
      }
      if (hasFlag(rest, "--bucket-region")) {
        throw new AxiError(
          "--bucket-region filters the bucket list and is only valid when listing all buckets (no s3:// URI)",
          "USAGE_ERROR",
          ["To filter buckets by region: aws-axi s3 ls --bucket-region us-east-1"],
        );
      }

      const recursive = hasFlag(rest, "--recursive");
      // Strip the s3:// URI positional before collecting passthrough so the
      // heuristic cannot consume it as a boolean flag's value.
      const argsForPassthrough = stripPositionals(rest, prefix);
      // --recursive sets recursive=true on s3LsRun (drops --delimiter /); it is
      // never forwarded to s3api list-objects-v2, which does not accept it.
      const rawPassthrough = collectPassthroughFlags(argsForPassthrough, ["--starting-token"], ["--recursive"]);
      const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);
      const result = await s3LsRun({ prefix, startingToken, recursive, passthrough, hasQuery, context });
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
          ["Usage: aws-axi s3 cp <source> <destination> [flags]"],
        );
      }
      const dryRun = hasFlag(rest, "--dryrun");
      // Strip identified positionals first. Once bare positionals are absent,
      // the heuristic safely identifies all remaining bare tokens as flag values.
      // --dryrun is a boolean overlay flag (no value follows); pass in ownedBoolFlags.
      const argsForPassthrough = stripPositionals(rest, source, destination);
      const rawPassthrough = collectPassthroughFlags(argsForPassthrough, [], ["--dryrun"]);
      // s3 cp uses awsExec (text output) — --query is forwarded verbatim but
      // there is no overlay projection to bypass, so hasQuery is intentionally unused.
      const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);
      void hasQuery;
      const result = await s3CpRun({ source, destination, dryRun, passthrough, context });
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
      // Strip the target URI positional to prevent heuristic from eating it.
      const argsForPassthrough = stripPositionals(rest, target);
      const rawPassthrough = collectPassthroughFlags(argsForPassthrough, [], ["--dryrun"]);
      // s3 rm uses awsExec (text output) — --query is forwarded verbatim but
      // there is no overlay projection to bypass, so hasQuery is intentionally unused.
      const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);
      void hasQuery;
      const result = await s3RmRun({ target, dryRun, passthrough, context });
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
      // Intercept aws s3-level flags that have no s3api head-object equivalent.
      // head-object fetches metadata for a single key; --recursive and display
      // flags from the high-level aws s3 commands do not apply here.
      if (hasFlag(rest, "--recursive")) {
        throw new AxiError(
          "--recursive is not valid for s3 head-object (head-object fetches metadata for a single key, not a prefix)",
          "USAGE_ERROR",
          ["Remove --recursive — head-object requires --bucket and --key for a single object"],
        );
      }
      // head-object maps to s3api head-object — all flags are named, no positionals.
      const rawPassthrough = collectPassthroughFlags(rest, ["--bucket", "--key"]);
      const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);
      const result = await s3HeadObjectRun({ bucket, key, passthrough, hasQuery, context });
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
      const rawPassthrough = collectPassthroughFlags(rest, ["--bucket", "--region"]);
      const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);
      const result = await s3CreateBucketRun({ bucket, region, passthrough, hasQuery, context });
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
