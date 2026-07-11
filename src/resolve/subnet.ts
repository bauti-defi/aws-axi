/**
 * resolve-subnet — resolve a subnet id to human-readable name + metadata.
 *
 * Calls `aws ec2 describe-subnets --subnet-ids <id>` and projects the
 * Name tag, AZ, CIDR, and parent VPC. Results are cached in-process so
 * commands iterating many subnets in the same describe call only pay once
 * per unique subnet id.
 *
 * Never throws — returns null on any error or not-found.
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

interface AwsSubnetRecord {
  readonly SubnetId: string;
  readonly VpcId: string;
  readonly CidrBlock: string;
  readonly AvailabilityZone: string;
  readonly AvailableIpAddressCount: number;
  readonly MapPublicIpOnLaunch: boolean;
  readonly State: string;
  readonly Tags?: readonly AwsTag[];
}

interface DescribeSubnetsResponse {
  readonly Subnets: readonly AwsSubnetRecord[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedSubnet {
  readonly id: string;
  /** Name tag value, or the subnet id if no Name tag. */
  readonly name: string;
  readonly vpcId: string;
  readonly cidr: string;
  readonly az: string;
}

export interface ResolveSubnetOptions {
  readonly id: string;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ---------------------------------------------------------------------------
// In-process cache — keyed by `${binary}::${id}` for test isolation
// ---------------------------------------------------------------------------

const cache = new Map<string, ResolvedSubnet | null>();

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a subnet id to its name (from the Name tag), AZ, CIDR, and VPC.
 * Returns null when the subnet is not found or any AWS error occurs.
 */
export async function resolveSubnet(
  options: ResolveSubnetOptions,
): Promise<ResolvedSubnet | null> {
  const cacheKey = `${options.binary ?? "aws"}::${options.id}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  try {
    const resp = await awsJson<DescribeSubnetsResponse>(
      ["ec2", "describe-subnets", "--subnet-ids", options.id],
      { binary: options.binary, context: options.context },
    );

    const subnet = resp.Subnets[0];
    if (!subnet) {
      cache.set(cacheKey, null);
      return null;
    }

    const name =
      subnet.Tags?.find((t) => t.Key === "Name")?.Value ?? subnet.SubnetId;

    const resolved: ResolvedSubnet = {
      id: subnet.SubnetId,
      name,
      vpcId: subnet.VpcId,
      cidr: subnet.CidrBlock,
      az: subnet.AvailabilityZone,
    };

    cache.set(cacheKey, resolved);
    return resolved;
  } catch {
    // Credentials missing, throttled, not found via error code, etc.
    // Errors are not cached — transient failures should be retriable.
    return null;
  }
}
