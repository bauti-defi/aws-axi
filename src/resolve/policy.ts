/**
 * resolve-policy — reusable primitive that turns a policy ARN or name into
 * a resolved display (name + arn).
 *
 * Used by higher-tier commands (EC2, ECS, Lambda) that carry raw policy ARNs
 * in their output and want to surface human-readable names.
 *
 * Resolution rules:
 *   ARN  ("arn:aws*:iam::*:policy/*") → parse name from the ARN (no network).
 *   Name → `aws iam list-policies --scope All` linear scan (expensive;
 *           prefer ARN input for production use).
 *
 * Results are cached per (nameOrArn + profile + region) key.
 */
import { awsJson } from "../aws.js";
import { AxiError } from "../errors.js";
import type { AwsContext } from "../context.js";

export interface ResolvedPolicy {
  readonly name: string;
  readonly arn: string;
}

export interface ResolvePolicyOptions {
  readonly nameOrArn: string;
  readonly context?: AwsContext;
  /** Override the aws binary path. Used in tests via real stub scripts. */
  readonly binary?: string;
  /**
   * Inject a cache map. If omitted the module-level default cache is used.
   * Pass a fresh `new Map()` in tests to isolate runs.
   */
  readonly _cache?: Map<string, ResolvedPolicy>;
}

// Module-level cache — lives for the process lifetime (one CLI invocation).
const MODULE_CACHE = new Map<string, ResolvedPolicy>();

interface IamRawPolicy {
  readonly PolicyName: string;
  readonly PolicyId: string;
  readonly Arn: string;
  readonly Path: string;
  readonly AttachmentCount: number;
  readonly CreateDate: string;
  readonly UpdateDate: string;
}

interface IamListPoliciesResponse {
  readonly Policies: readonly IamRawPolicy[];
  readonly IsTruncated: boolean;
  readonly NextToken?: string;
}

/** Return true if the input is a policy ARN in any AWS partition. */
function isArn(s: string): boolean {
  return (
    s.startsWith("arn:aws:iam::") ||
    s.startsWith("arn:aws-cn:iam::") ||
    s.startsWith("arn:aws-us-gov:iam::")
  );
}

/**
 * Extract the policy name from an ARN.
 * Policy ARNs can have paths: `arn:aws:iam::123:policy/service-role/MyPolicy`.
 * The name is always the last segment.
 */
function nameFromArn(arn: string): string {
  const parts = arn.split("/");
  const last = parts[parts.length - 1];
  if (!last) {
    throw new AxiError(`Cannot parse policy name from ARN: ${arn}`, "USAGE_ERROR");
  }
  return last;
}

function cacheKey(nameOrArn: string, context: AwsContext | undefined): string {
  return `${nameOrArn}::${context?.profile ?? ""}::${context?.region ?? ""}`;
}

/**
 * Resolve a policy ARN or name into { name, arn }.
 *
 * ARN input  → pure parse; no network call.
 * Name input → `aws iam list-policies --scope All` linear scan; result cached.
 */
export async function resolvePolicy(
  options: ResolvePolicyOptions,
): Promise<ResolvedPolicy> {
  const { nameOrArn, context, binary } = options;
  const cache = options._cache ?? MODULE_CACHE;
  const key = cacheKey(nameOrArn, context);

  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let result: ResolvedPolicy;

  if (isArn(nameOrArn)) {
    // Fast path: name is embedded in the ARN — no network call needed.
    result = { name: nameFromArn(nameOrArn), arn: nameOrArn };
  } else {
    // Slow path: list all policies and search by name.
    const response = await awsJson<IamListPoliciesResponse>(
      ["iam", "list-policies", "--scope", "All", "--max-items", "1000"],
      { binary, context },
    );
    const found = response.Policies.find((p) => p.PolicyName === nameOrArn);
    if (!found) {
      throw new AxiError(
        `Policy not found: ${nameOrArn}`,
        "SERVICE_CLIENT_ERROR",
        [
          "Use the full policy ARN for direct lookup: e.g. arn:aws:iam::aws:policy/AdministratorAccess",
          "Run `aws-axi iam list-policies` to see available policies",
        ],
      );
    }
    result = { name: found.PolicyName, arn: found.Arn };
  }

  cache.set(key, result);
  return result;
}
