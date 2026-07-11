/**
 * resolve-sg — resolve a security group id to human-readable name + metadata.
 *
 * Calls `aws ec2 describe-security-groups --group-ids <id>` and projects
 * the GroupName and Description. Results are cached in-process so commands
 * that reference many SGs (e.g. ECS tasks, Lambda VPC configs) only pay
 * one API call per unique group id.
 *
 * Never throws — returns null on any error or not-found.
 */
import { awsJson } from "../aws.js";
import type { AwsContext } from "../context.js";

// ---------------------------------------------------------------------------
// Raw AWS response types
// ---------------------------------------------------------------------------

interface AwsSecurityGroupRecord {
  readonly GroupId: string;
  readonly GroupName: string;
  readonly Description: string;
  readonly VpcId?: string;
}

interface DescribeSecurityGroupsResponse {
  readonly SecurityGroups: readonly AwsSecurityGroupRecord[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedSg {
  readonly id: string;
  /** GroupName from the security group. */
  readonly name: string;
  readonly description: string;
}

export interface ResolveSgOptions {
  readonly id: string;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ---------------------------------------------------------------------------
// In-process cache — keyed by `${binary}::${id}` for test isolation
// ---------------------------------------------------------------------------

const cache = new Map<string, ResolvedSg | null>();

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a security group id to its name (GroupName) and description.
 * Returns null when the group is not found or any AWS error occurs.
 */
export async function resolveSg(
  options: ResolveSgOptions,
): Promise<ResolvedSg | null> {
  const cacheKey = `${options.binary ?? "aws"}::${options.id}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  try {
    const resp = await awsJson<DescribeSecurityGroupsResponse>(
      ["ec2", "describe-security-groups", "--group-ids", options.id],
      { binary: options.binary, context: options.context },
    );

    const sg = resp.SecurityGroups[0];
    if (!sg) {
      cache.set(cacheKey, null);
      return null;
    }

    const resolved: ResolvedSg = {
      id: sg.GroupId,
      name: sg.GroupName,
      description: sg.Description,
    };

    cache.set(cacheKey, resolved);
    return resolved;
  } catch {
    // Credentials missing, throttled, not found via error code, etc.
    // Errors are not cached — transient failures should be retriable.
    return null;
  }
}
