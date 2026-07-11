/**
 * resolve-role — reusable primitive that turns a role ARN or name into
 * a resolved display (name + arn).
 *
 * Used by higher-tier commands (EC2, ECS, Lambda, RDS) to enrich output
 * that contains raw IAM role ARNs. Build once here; import everywhere.
 *
 * Resolution rules:
 *   ARN  ("arn:aws*:iam::*:role/*") → parse name from the ARN (no network).
 *   Name → call `aws iam get-role --role-name <name>` to get the canonical ARN.
 *
 * Results are cached per (nameOrArn + profile + region) key so repeated
 * lookups within the same invocation are free.
 */
import { awsJson } from "../aws.js";
import { AxiError } from "../errors.js";
import type { AwsContext } from "../context.js";

export interface ResolvedRole {
  readonly name: string;
  readonly arn: string;
}

export interface ResolveRoleOptions {
  readonly nameOrArn: string;
  readonly context?: AwsContext;
  /** Override the aws binary path. Used in tests via real stub scripts. */
  readonly binary?: string;
  /**
   * Inject a cache map. If omitted the module-level default cache is used.
   * Pass a fresh `new Map()` in tests to isolate runs.
   */
  readonly _cache?: Map<string, ResolvedRole>;
}

// Module-level cache — lives for the process lifetime (one CLI invocation).
const MODULE_CACHE = new Map<string, ResolvedRole>();

interface IamGetRoleResponse {
  readonly Role: {
    readonly RoleName: string;
    readonly RoleId: string;
    readonly Arn: string;
    readonly CreateDate: string;
    readonly Path: string;
    readonly MaxSessionDuration?: number;
    readonly Description?: string;
  };
}

/** Return true if the input is an IAM role ARN in any AWS partition. */
function isArn(s: string): boolean {
  return (
    s.startsWith("arn:aws:iam::") ||
    s.startsWith("arn:aws-cn:iam::") ||
    s.startsWith("arn:aws-us-gov:iam::")
  );
}

/**
 * Extract the role name from an ARN.
 * Handles both simple (`role/name`) and path-qualified (`role/path/name`) forms.
 * The role name is always the last path segment.
 */
function nameFromArn(arn: string): string {
  const parts = arn.split("/");
  const last = parts[parts.length - 1];
  if (!last) {
    throw new AxiError(`Cannot parse role name from ARN: ${arn}`, "USAGE_ERROR");
  }
  return last;
}

function cacheKey(nameOrArn: string, context: AwsContext | undefined): string {
  return `${nameOrArn}::${context?.profile ?? ""}::${context?.region ?? ""}`;
}

/**
 * Resolve a role ARN or name into { name, arn }.
 *
 * ARN input  → pure parse; no network call.
 * Name input → `aws iam get-role --role-name <name>`; result cached.
 */
export async function resolveRole(
  options: ResolveRoleOptions,
): Promise<ResolvedRole> {
  const { nameOrArn, context, binary } = options;
  const cache = options._cache ?? MODULE_CACHE;
  const key = cacheKey(nameOrArn, context);

  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let result: ResolvedRole;

  if (isArn(nameOrArn)) {
    // Fast path: name is embedded in the ARN — no network call needed.
    result = { name: nameFromArn(nameOrArn), arn: nameOrArn };
  } else {
    // Slow path: look up by name to get the canonical ARN.
    const response = await awsJson<IamGetRoleResponse>(
      ["iam", "get-role", "--role-name", nameOrArn],
      { binary, context },
    );
    result = {
      name: response.Role.RoleName,
      arn: response.Role.Arn,
    };
  }

  cache.set(key, result);
  return result;
}
