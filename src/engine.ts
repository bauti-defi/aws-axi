/**
 * Model-driven generic engine — dispatches ANY aws-axi <service> <operation>
 * for services WITHOUT a hand-polished overlay.
 *
 * Reads the on-disk botocore service models (installed with the AWS CLI v2) to:
 *   - Validate required params (USAGE_ERROR + distilled signature on failure)
 *   - Cap auto-pagination via --max-items; gate truncation ONLY on synthesized NextToken
 *   - Strip user --output flags to prevent double --output json from the exec seam
 *   - Map errors via the existing taxonomy and surface operation-known error hints
 *   - Project raw JSON → plain object (ResponseMetadata stripped) for TOON rendering
 *
 * Pagination contract (CRITICAL — the #1 token hazard):
 *   botocore's --max-items paginator STRIPS native truncation fields
 *   (IsTruncated / Marker / Truncated / NextContinuationToken) and emits ONLY
 *   the aggregated result-key(s) + a literal "NextToken". We NEVER gate truncation
 *   on native flags — those are dead code once --max-items is in effect.
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "./context.js";
import { awsJson } from "./aws.js";
import {
  loadService,
  resolveOperationName,
  pascalToKebab,
  getPaginator,
  type OperationInfo,
  type PaginatorConfig,
  type ServiceModel,
} from "./model.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface EngineRunOptions {
  /** AWS service name as the CLI knows it (e.g., "sqs", "dynamodb"). */
  readonly service: string;
  /** Operation name in CLI kebab-case (e.g., "list-queues", "get-ip-set"). Resolved internally via reverse-map lookup. */
  readonly operation: string;
  /** All remaining flags/args after service + operation, already stripped of --profile/--region. */
  readonly args: readonly string[];
  readonly context?: AwsContext;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  /** Default page cap for paginated ops. Overridden by an explicit --max-items in args. */
  readonly maxItems?: number;
  /** Override botocore data dir — for tests that use fixture models. */
  readonly dataDir?: string;
}

/** Default item cap for auto-paginated operations (token-safety contract). */
const DEFAULT_MAX_ITEMS = 50;

/**
 * Maps AWS CLI top-level command names to their botocore model directory names
 * when the two differ.
 *
 * Most CLI services are 1:1 with a botocore directory (e.g. "sqs" → "sqs/",
 * "ec2" → "ec2/"). This table covers the known exceptions enumerated by
 * diffing `awscli/data/ac.index` (421 top-level commands) against the botocore
 * data directory (416 dirs) on AWS CLI v2.33.x.
 *
 * Alias contract: the alias applies ONLY to model lookup (for validation); the
 * child-process argv always uses the original CLI name because that is what
 * `aws <service> <op>` expects on the wire.
 *
 * Deliberate non-entries:
 *   - `ddb`: not a botocore alias. It is an `awscli` high-level command (only
 *     `put` / `select`) with its own argument grammar. Aliasing it to `dynamodb`
 *     would silently accept invalid input. Tracked in a follow-up issue.
 *   - CLI meta-commands (`configure`, `login`, `logout`, `history`, `cli-dev`)
 *     are not AWS services and correctly produce USAGE_ERROR if passed as service.
 *
 * Exported so the inverse direction (`s3 → s3api` for waiters in #76) can be
 * derived from a single source of truth rather than a separate hand-maintained
 * table in a second file.
 *
 * NOTE: uses `Object.create(null)` to sever the prototype chain — prevents
 * inherited Object.prototype keys (`toString`, `constructor`, etc.) from being
 * resolved as botocore model names by the `Object.hasOwn` guard below.
 */
export const SERVICE_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    s3api: "s3",
    configservice: "config",
    deploy: "codedeploy",
  }),
);

/**
 * Convert a botocore PascalCase parameter name to its CLI --flag form.
 * "Bucket"    → "--bucket"
 * "QueueUrl"  → "--queue-url"
 * "MaxResults" → "--max-results"
 */
export function toCliFlag(paramName: string): string {
  // Insert a hyphen before each uppercase letter that follows a lowercase letter or digit
  return "--" + paramName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// ── CLI flag / arg helpers — pure, exported for tests ────────────────────────

/**
 * Strip --output (and its value) from user args.
 * The exec seam always appends --output json; a user-supplied --output conflicts.
 * Handles both "--output table" (two-arg) and "--output=table" (equals) forms.
 */
export function stripOutputFlag(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--output" && i + 1 < args.length) {
      // Skip "--output <value>" — two-argument form
      i++;
    } else if (arg.startsWith("--output=")) {
      // Skip "--output=<value>" — equals form
    } else {
      out.push(arg);
    }
  }
  return out;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Return true if a CLI flag for the given PascalCase param name is present in args.
 * Matches both "--flag value" and "--flag=value" forms.
 */
function isParamPresent(paramName: string, args: readonly string[]): boolean {
  const flag = toCliFlag(paramName);
  return args.some((a) => a === flag || a.startsWith(flag + "="));
}

/** Return true if --max-items is already present in args. */
function hasMaxItemsFlag(args: readonly string[]): boolean {
  return args.some((a) => a === "--max-items" || a.startsWith("--max-items="));
}

/**
 * Return true if --query is present in args.
 *
 * --query contract (ADR-0002): JMESPath is applied by the aws CLI before the
 * response reaches the engine. The result shape is unknown and may be an
 * array — the engine MUST skip its cap and its curated projection when --query
 * is active. Without --max-items, botocore auto-pages to completion (same
 * semantics as real `aws`); the caller keeps an explicit re-cap by supplying
 * their own --max-items (last-wins).
 */
function hasQueryFlag(args: readonly string[]): boolean {
  return args.some((a) => a === "--query" || a.startsWith("--query="));
}

/**
 * Format the distilled signature for a USAGE_ERROR message.
 * Gives the agent a compact view of what the operation expects.
 */
function formatSignature(
  service: string,
  operation: string,
  info: OperationInfo,
): string {
  const params = info.signature.inputParams
    .map(
      (p) =>
        `${toCliFlag(p.name)} <${p.type}>${p.required ? " (required)" : ""}`,
    )
    .join("\n  ");

  return (
    `aws-axi ${service} ${operation}` +
    (params.length > 0 ? `\n  ${params}` : "")
  );
}

/**
 * Extract the botocore error code from an AxiError message.
 * Message format: "<Code> calling <Op>: <detail>"
 */
function extractBotoCode(message: string): string | undefined {
  const m = /^(\w+) calling/.exec(message);
  return m?.[1];
}

// ── Core engine ───────────────────────────────────────────────────────────────

/**
 * Dispatch an AWS operation via the model-driven generic engine.
 *
 * Steps:
 *   1. Load botocore service model (with caching)
 *   2. Resolve operation name (kebab → PascalCase)
 *   3. Validate required params — fail fast USAGE_ERROR with signature
 *   4. Strip --output from user args
 *   5. For paginated ops: inject --max-items cap if not already present
 *   6. Execute via awsJson exec seam
 *   7. Augment any known errors with operation-specific hints
 *   8. Project output: strip ResponseMetadata, add pagination metadata
 *
 * @throws AxiError on validation failures, exec errors, or unknown service/op
 */
export async function engineRun(
  options: EngineRunOptions,
): Promise<Record<string, unknown>> {
  const { service, operation, context, binary, dataDir } = options;
  const maxItemsCap = options.maxItems ?? DEFAULT_MAX_ITEMS;

  // Resolve botocore model name: some CLI service names differ from the
  // botocore directory name. Use the alias for model lookup only; the wire
  // call (awsArgs) always uses the original CLI service name.
  // Object.hasOwn guards against prototype-chain lookups (SERVICE_ALIASES uses
  // Object.create(null) but the hasOwn guard makes the contract explicit).
  const modelService = Object.hasOwn(SERVICE_ALIASES, service)
    ? (SERVICE_ALIASES[service] as string)
    : service;

  // ── 1. Load service model ──────────────────────────────────────────────────
  let model: ServiceModel;
  try {
    model = loadService(modelService, { dataDir });
  } catch (err) {
    throw new AxiError(
      `Unknown service '${service}': ${err instanceof Error ? err.message : String(err)}`,
      "USAGE_ERROR",
      [
        "Check the service name matches the AWS CLI (e.g. sqs, ec2, s3).",
        "Run `aws help` to list available services.",
      ],
    );
  }

  // ── 2. Resolve operation (CLI kebab-case → exact botocore PascalCase) ───────
  // Uses a reverse-map over the model's real PascalCase keys — the only correct
  // approach for acronym-bearing names (e.g. get-ip-set → GetIPSet, not GetIpSet).
  const pascalKey = resolveOperationName(model, operation);
  if (pascalKey === undefined) {
    // Surface first 10 available ops (as kebab-case) in the hint
    const available = [...model.operations.keys()]
      .slice(0, 10)
      .map(pascalToKebab);
    throw new AxiError(
      `Unknown operation '${operation}' for service '${service}'.`,
      "USAGE_ERROR",
      [
        "Check the operation name matches the AWS CLI.",
        `Available operations (first 10): ${available.join(", ")}`,
      ],
    );
  }
  // pascalKey is verified to exist in the map — non-null assertion is safe.
  const opInfo = model.operations.get(pascalKey) as OperationInfo;

  // ── 3. Validate required params ────────────────────────────────────────────
  // Strip --output first (it affects arg scanning but not required-param check)
  const cleanedArgs = stripOutputFlag(options.args);

  const missingRequired = opInfo.required.filter(
    (p) => !isParamPresent(p, cleanedArgs),
  );
  if (missingRequired.length > 0) {
    const missingFlags = missingRequired.map(toCliFlag).join(", ");
    throw new AxiError(
      `Missing required parameter(s) for ${service} ${operation}: ${missingFlags}\n\nSignature:\n  ${formatSignature(service, operation, opInfo)}`,
      "USAGE_ERROR",
      missingRequired.map((p) => `Provide ${toCliFlag(p)} <value>`),
    );
  }

  // ── 4. Pagination setup ────────────────────────────────────────────────────
  const paginator = getPaginator(model, pascalKey);
  const awsArgs: string[] = [service, operation, ...cleanedArgs];

  // --query bypass (ADR-0002): when --query is active, JMESPath is applied by
  // the aws CLI before the response reaches us. The result shape is unknown
  // (may be an array), so we skip the overlay's default cap AND its curated
  // projection. Without --max-items, botocore auto-pages the complete result.
  // The caller retains an explicit re-cap via --max-items N (last-wins):
  // hasMaxItemsFlag gates on the user-supplied value already present in
  // cleanedArgs, so an explicit --max-items + --query combination is honored.
  const queryActive = hasQueryFlag(cleanedArgs);
  if (paginator !== undefined && !hasMaxItemsFlag(cleanedArgs) && !queryActive) {
    awsArgs.push("--max-items", String(maxItemsCap));
  }

  // ── 5. Execute via exec seam ───────────────────────────────────────────────
  // awsJson handles DryRunOperation (returns {}) and ENOENT already.
  let raw: Record<string, unknown>;
  try {
    raw = await awsJson<Record<string, unknown>>(awsArgs, { binary, context });
  } catch (err) {
    if (err instanceof AxiError) {
      // Augment SERVICE_CLIENT_ERROR with operation-specific error hints when
      // the botoCode matches one of the operation's declared errors.
      const botoCode = extractBotoCode(err.message);
      if (
        botoCode !== undefined &&
        opInfo.errors.length > 0 &&
        opInfo.errors.includes(botoCode)
      ) {
        throw new AxiError(err.message, err.code, [
          ...err.suggestions,
          `This is a known error for ${service} ${operation}: ${botoCode}`,
        ]);
      }
    }
    throw err;
  }

  // ── 6. Project output ──────────────────────────────────────────────────────
  // --query bypass: JMESPath was applied by the aws CLI; skip curated
  // projection. The result shape is unknown and may be an array — returning
  // raw is the only safe option (mirrors the per-overlay hasQuery pattern).
  if (queryActive) {
    return raw;
  }
  return projectOutput(raw, paginator, service, operation);
}

/**
 * Shared seam: delegate an unrecognised overlay op to the model-driven engine.
 *
 * Called from each overlay command's unknown-op branch so the fall-through is
 * uniform across ec2, iam, s3, kms, logs, lambda, ssm, and secretsmanager.
 *
 * The caller passes:
 *   service   — AWS service name as the CLI knows it (e.g. "ec2", "logs")
 *   operation — CLI kebab-case op exactly as typed by the user (e.g. "describe-regions")
 *   args      — all args AFTER the operation, RAW (profile/region already in context)
 *   context   — resolved AWS context from the CLI layer
 *
 * The engine validates the op against the botocore service model and returns a
 * clean USAGE_ERROR for ops that are truly unknown to AWS — so the overlay no
 * longer needs its own hardcoded allowlist for the long tail.
 */
export function fallThroughToEngine(
  service: string,
  operation: string,
  args: readonly string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  return engineRun({ service, operation, args, context });
}

/**
 * Project raw AWS JSON output into an agent-friendly object.
 *
 * - Strips ResponseMetadata (envelope noise, not useful for agents).
 * - For paginated ops: adds count + truncation info keyed on paginator's resultKey.
 * - Gates truncation ONLY on synthesized "NextToken" — never on IsTruncated /
 *   Marker / Truncated / NextContinuationToken (those are stripped by botocore
 *   --max-items and would be dead code here).
 */
function projectOutput(
  raw: Record<string, unknown>,
  paginator: PaginatorConfig | undefined,
  service: string,
  operation: string,
): Record<string, unknown> {
  // Strip ResponseMetadata from every response — it's envelope noise.
  const { ResponseMetadata: _rm, ...result } = raw;

  if (paginator === undefined) {
    // Non-paginated op: return cleaned result as-is.
    return result;
  }

  // Paginated path — use the first result_key to count the returned list.
  const primaryResultKey = paginator.resultKeys[0];
  if (primaryResultKey === undefined) {
    return result;
  }

  const items = result[primaryResultKey];
  const itemCount = Array.isArray(items) ? items.length : undefined;

  // Gate truncation ONLY on the botocore-synthesized "NextToken".
  // botocore --max-items strips native flags (IsTruncated / Marker / etc.)
  // and emits a single synthetic "NextToken" when more pages exist.
  const nextToken =
    typeof result["NextToken"] === "string" ? result["NextToken"] : undefined;
  const truncated = nextToken !== undefined;

  const output: Record<string, unknown> = { ...result };

  if (itemCount !== undefined) {
    output["count"] = itemCount;
  }

  if (truncated) {
    output["truncated"] = true;
    output["nextToken"] = nextToken;
    output["help"] = [
      `Showing ${itemCount ?? "?"} items (more available).`,
      `Resume with: aws-axi ${service} ${operation} --starting-token ${nextToken}`,
    ];
  }

  return output;
}
