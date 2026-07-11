/**
 * resolve-vpc — resolve a VPC id to human-readable name + metadata.
 *
 * Calls `aws ec2 describe-vpcs --vpc-ids <id>` and projects the Name tag.
 * Results are cached in-process (keyed by binary+id) so higher-tier commands
 * that call this for N resources in the same VPC only pay one API call.
 *
 * Never throws — returns null on any error or not-found so callers can
 * gracefully degrade to showing the raw id.
 */
import { awsJson } from "../aws.js";
import type { AwsContext } from "../context.js";

// ---------------------------------------------------------------------------
// Raw AWS response types
// ---------------------------------------------------------------------------

interface AwsTag {
  readonly Key: string;
  readonly Value: string;
}

interface AwsVpcRecord {
  readonly VpcId: string;
  readonly CidrBlock: string;
  readonly State: string;
  readonly IsDefault: boolean;
  readonly Tags?: readonly AwsTag[];
}

interface DescribeVpcsResponse {
  readonly Vpcs: readonly AwsVpcRecord[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedVpc {
  readonly id: string;
  /** Name tag value, or the VPC id if no Name tag. */
  readonly name: string;
  readonly cidr: string;
}

export interface ResolveVpcOptions {
  readonly id: string;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ---------------------------------------------------------------------------
// In-process cache — keyed by `${binary}::${id}` for test isolation
// ---------------------------------------------------------------------------

const cache = new Map<string, ResolvedVpc | null>();

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a VPC id to its name (from the Name tag) and CIDR.
 * Returns null when the VPC is not found or any AWS error occurs.
 */
export async function resolveVpc(
  options: ResolveVpcOptions,
): Promise<ResolvedVpc | null> {
  const cacheKey = `${options.binary ?? "aws"}::${options.id}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  try {
    const resp = await awsJson<DescribeVpcsResponse>(
      ["ec2", "describe-vpcs", "--vpc-ids", options.id],
      { binary: options.binary, context: options.context },
    );

    const vpc = resp.Vpcs[0];
    if (!vpc) {
      cache.set(cacheKey, null);
      return null;
    }

    const name =
      vpc.Tags?.find((t) => t.Key === "Name")?.Value ?? vpc.VpcId;

    const resolved: ResolvedVpc = {
      id: vpc.VpcId,
      name,
      cidr: vpc.CidrBlock,
    };

    cache.set(cacheKey, resolved);
    return resolved;
  } catch {
    // Credentials missing, throttled, not found via error code, etc.
    // We do NOT cache errors — transient failures should be retriable.
    return null;
  }
}
