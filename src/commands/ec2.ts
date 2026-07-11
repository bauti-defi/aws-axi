/**
 * `aws-axi ec2` — EC2 networking reads (Tier 0).
 *
 * Hand-polished overlays for the three EC2 networking describe operations:
 *   describe-vpcs, describe-subnets, describe-security-groups
 *
 * Each mirrors the AWS CLI operation name 1:1 and projects raw AWS JSON into
 * a curated, token-efficient TOON shape. Pagination is capped at DEFAULT_MAX
 * items; truncation is reported honestly with a next-token continuation hint.
 *
 * NOTE: EC2 *instances* (describe-instances, run-instances, etc.) are a
 * separate Tier-1 slice that will extend this same command file. Keep the
 * networking operations cleanly namespaced so that slice can add to this file
 * without touching networking logic.
 *
 * Exported shape:
 *   ec2Run({ operation, maxItems, nextToken, context, binary })  → typed object
 *   ec2Command(args, context)                                    → AxiCliCommand adapter
 *   EC2_HELP                                                     → help text
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import { awsJson } from "../aws.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page cap — matches the design spec's token-safety contract. */
const DEFAULT_MAX_ITEMS = 50;

// ---------------------------------------------------------------------------
// Raw AWS response types (EC2 networking)
// ---------------------------------------------------------------------------

interface AwsTag {
  readonly Key: string;
  readonly Value: string;
}

interface AwsVpc {
  readonly VpcId: string;
  readonly CidrBlock: string;
  readonly State: string;
  readonly IsDefault: boolean;
  readonly Tags?: readonly AwsTag[];
}

interface DescribeVpcsResponse {
  readonly Vpcs: readonly AwsVpc[];
  readonly NextToken?: string;
}

interface AwsSubnet {
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
  readonly Subnets: readonly AwsSubnet[];
  readonly NextToken?: string;
}

interface AwsIpPermission {
  readonly IpProtocol: string;
  readonly FromPort?: number;
  readonly ToPort?: number;
  readonly IpRanges?: readonly { readonly CidrIp: string }[];
}

interface AwsSecurityGroup {
  readonly GroupId: string;
  readonly GroupName: string;
  readonly Description: string;
  readonly VpcId?: string;
  readonly IpPermissions: readonly AwsIpPermission[];
  readonly IpPermissionsEgress: readonly AwsIpPermission[];
  readonly Tags?: readonly AwsTag[];
}

interface DescribeSecurityGroupsResponse {
  readonly SecurityGroups: readonly AwsSecurityGroup[];
  readonly NextToken?: string;
}

// ---------------------------------------------------------------------------
// Curated output types
// ---------------------------------------------------------------------------

interface VpcSummary {
  readonly id: string;
  readonly name: string;
  readonly cidr: string;
  readonly state: string;
  readonly default: boolean;
}

interface SubnetSummary {
  readonly id: string;
  readonly name: string;
  readonly vpc: string;
  readonly cidr: string;
  readonly az: string;
  readonly availableIps: number;
  readonly publicIpOnLaunch: boolean;
}

interface SgSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly vpc: string;
  readonly inboundRules: number;
  readonly outboundRules: number;
}

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export type Ec2NetworkingOperation =
  | "describe-vpcs"
  | "describe-subnets"
  | "describe-security-groups";

/** The superset of valid operations this module handles. */
const NETWORKING_OPERATIONS: ReadonlySet<string> = new Set<Ec2NetworkingOperation>([
  "describe-vpcs",
  "describe-subnets",
  "describe-security-groups",
]);

export interface Ec2RunOptions {
  readonly operation: Ec2NetworkingOperation;
  /** Max items to return. Defaults to DEFAULT_MAX_ITEMS (50). */
  readonly maxItems?: number;
  /** Pagination resume token from a previous truncated result. */
  readonly nextToken?: string;
  readonly context?: AwsContext;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const EC2_HELP = `usage: aws-axi ec2 <operation> [--profile <name>] [--region <region>] [flags]

operations[3]:
  describe-vpcs, describe-subnets, describe-security-groups

flags:
  --profile <name>     AWS profile to use (default: AWS_PROFILE env or "default")
  --region <region>    AWS region to use (default: AWS_REGION / AWS_DEFAULT_REGION env)
  --max-items <n>      Max items to return per page (default: 50)
  --next-token <tok>   Resume pagination from this token

examples:
  aws-axi ec2 describe-vpcs
  aws-axi ec2 describe-vpcs --profile prod --region us-west-2
  aws-axi ec2 describe-subnets
  aws-axi ec2 describe-subnets --max-items 10
  aws-axi ec2 describe-subnets --next-token <token>
  aws-axi ec2 describe-security-groups
`;

// ---------------------------------------------------------------------------
// Pure projection helpers
// ---------------------------------------------------------------------------

function nameTag(tags: readonly AwsTag[] | undefined, fallback: string): string {
  return tags?.find((t) => t.Key === "Name")?.Value ?? fallback;
}

function buildPaginationArgs(options: {
  readonly maxItems: number;
  readonly nextToken?: string;
}): readonly string[] {
  const args: string[] = ["--max-items", String(options.maxItems)];
  if (options.nextToken) {
    args.push("--starting-token", options.nextToken);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Per-operation implementations
// ---------------------------------------------------------------------------

async function describeVpcs(
  options: Ec2RunOptions,
): Promise<Record<string, unknown>> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const resp = await awsJson<DescribeVpcsResponse>(
    [
      "ec2",
      "describe-vpcs",
      ...buildPaginationArgs({ maxItems, nextToken: options.nextToken }),
    ],
    { binary: options.binary, context: options.context },
  );

  const vpcs: VpcSummary[] = resp.Vpcs.map((v) => ({
    id: v.VpcId,
    name: nameTag(v.Tags, v.VpcId),
    cidr: v.CidrBlock,
    state: v.State,
    default: v.IsDefault,
  }));

  const truncated = resp.NextToken !== undefined;

  if (vpcs.length === 0) {
    return {
      vpcs: [],
      count: 0,
      help: [
        "Create a VPC with: aws ec2 create-vpc --cidr-block 10.0.0.0/16",
        "Or check a different region with: aws-axi ec2 describe-vpcs --region <region>",
      ],
    };
  }

  const result: Record<string, unknown> = {
    vpcs,
    count: vpcs.length,
  };

  if (truncated) {
    result["truncated"] = true;
    result["nextToken"] = resp.NextToken;
    result["help"] = [
      `Showing ${vpcs.length} VPCs (more available).`,
      `Continue with: aws-axi ec2 describe-vpcs --next-token ${resp.NextToken ?? ""}`,
    ];
  }

  return result;
}

async function describeSubnets(
  options: Ec2RunOptions,
): Promise<Record<string, unknown>> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const resp = await awsJson<DescribeSubnetsResponse>(
    [
      "ec2",
      "describe-subnets",
      ...buildPaginationArgs({ maxItems, nextToken: options.nextToken }),
    ],
    { binary: options.binary, context: options.context },
  );

  const subnets: SubnetSummary[] = resp.Subnets.map((s) => ({
    id: s.SubnetId,
    name: nameTag(s.Tags, s.SubnetId),
    vpc: s.VpcId,
    cidr: s.CidrBlock,
    az: s.AvailabilityZone,
    availableIps: s.AvailableIpAddressCount,
    publicIpOnLaunch: s.MapPublicIpOnLaunch,
  }));

  const truncated = resp.NextToken !== undefined;

  if (subnets.length === 0) {
    return {
      subnets: [],
      count: 0,
      help: [
        "No subnets found in the current region.",
        "Create one with: aws ec2 create-subnet --vpc-id <vpc-id> --cidr-block <cidr>",
        "Or check a different region with: aws-axi ec2 describe-subnets --region <region>",
      ],
    };
  }

  const result: Record<string, unknown> = {
    subnets,
    count: subnets.length,
  };

  if (truncated) {
    result["truncated"] = true;
    result["nextToken"] = resp.NextToken;
    result["help"] = [
      `Showing ${subnets.length} subnets (more available).`,
      `Continue with: aws-axi ec2 describe-subnets --next-token ${resp.NextToken ?? ""}`,
    ];
  }

  return result;
}

async function describeSecurityGroups(
  options: Ec2RunOptions,
): Promise<Record<string, unknown>> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const resp = await awsJson<DescribeSecurityGroupsResponse>(
    [
      "ec2",
      "describe-security-groups",
      ...buildPaginationArgs({ maxItems, nextToken: options.nextToken }),
    ],
    { binary: options.binary, context: options.context },
  );

  const securityGroups: SgSummary[] = resp.SecurityGroups.map((sg) => ({
    id: sg.GroupId,
    name: sg.GroupName,
    description: sg.Description,
    vpc: sg.VpcId ?? "",
    inboundRules: sg.IpPermissions.length,
    outboundRules: sg.IpPermissionsEgress.length,
  }));

  const truncated = resp.NextToken !== undefined;

  if (securityGroups.length === 0) {
    return {
      securityGroups: [],
      count: 0,
      help: [
        "No security groups found in the current region.",
        "Create one with: aws ec2 create-security-group --group-name <name> --description <desc> --vpc-id <vpc-id>",
      ],
    };
  }

  const result: Record<string, unknown> = {
    securityGroups,
    count: securityGroups.length,
  };

  if (truncated) {
    result["truncated"] = true;
    result["nextToken"] = resp.NextToken;
    result["help"] = [
      `Showing ${securityGroups.length} security groups (more available).`,
      `Continue with: aws-axi ec2 describe-security-groups --next-token ${resp.NextToken ?? ""}`,
    ];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Core logic — testable without the CLI layer
// ---------------------------------------------------------------------------

/**
 * Run an EC2 networking read operation and return the curated result object.
 *
 * Throws AxiError (USAGE_ERROR) for unknown operations; propagates AxiError
 * from the exec seam for credential and service errors.
 */
export async function ec2Run(
  options: Ec2RunOptions,
): Promise<Record<string, unknown>> {
  const op = options.operation as string;

  if (!NETWORKING_OPERATIONS.has(op)) {
    throw new AxiError(
      `Unknown ec2 operation: ${op}. Run \`aws-axi ec2 --help\` to see supported operations.`,
      "USAGE_ERROR",
      [
        `Supported networking operations: ${[...NETWORKING_OPERATIONS].join(", ")}`,
        "For other EC2 operations, use the generic engine: aws ec2 <operation>",
      ],
    );
  }

  switch (options.operation) {
    case "describe-vpcs":
      return describeVpcs(options);
    case "describe-subnets":
      return describeSubnets(options);
    case "describe-security-groups":
      return describeSecurityGroups(options);
  }
}

// ---------------------------------------------------------------------------
// AxiCliCommand adapter
// ---------------------------------------------------------------------------

/**
 * Parse a --max-items flag from args, returning the value and the remaining args.
 */
function parseMaxItems(
  args: readonly string[],
): { maxItems: number | undefined; rest: string[] } {
  const rest: string[] = [];
  let maxItems: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--max-items" && i + 1 < args.length) {
      const val = parseInt(args[i + 1] ?? "", 10);
      if (isNaN(val) || val <= 0) {
        throw new AxiError(
          `--max-items must be a positive integer, got: ${args[i + 1] ?? ""}`,
          "USAGE_ERROR",
          ["Example: aws-axi ec2 describe-subnets --max-items 10"],
        );
      }
      maxItems = val;
      i++;
    } else if (arg.startsWith("--max-items=")) {
      const val = parseInt(arg.slice("--max-items=".length), 10);
      if (isNaN(val) || val <= 0) {
        throw new AxiError(
          `--max-items must be a positive integer, got: ${arg.slice("--max-items=".length)}`,
          "USAGE_ERROR",
          ["Example: aws-axi ec2 describe-subnets --max-items 10"],
        );
      }
      maxItems = val;
    } else {
      rest.push(arg);
    }
  }

  return { maxItems, rest };
}

/**
 * Parse a --next-token flag from args, returning the value and the remaining args.
 */
function parseNextToken(
  args: readonly string[],
): { nextToken: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let nextToken: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--next-token" && i + 1 < args.length) {
      nextToken = args[i + 1];
      i++;
    } else if (arg.startsWith("--next-token=") && arg.length > "--next-token=".length) {
      nextToken = arg.slice("--next-token=".length);
    } else {
      rest.push(arg);
    }
  }

  return { nextToken, rest };
}

/**
 * AxiCliCommand adapter.
 * args[0] is the EC2 operation (e.g. "describe-vpcs").
 * --profile/--region are pre-stripped by the CLI wrapper.
 */
export async function ec2Command(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const operation = args[0];

  if (!operation || operation.startsWith("-")) {
    throw new AxiError(
      "aws-axi ec2 requires an operation. Run `aws-axi ec2 --help` for usage.",
      "USAGE_ERROR",
      [
        "Supported operations: describe-vpcs, describe-subnets, describe-security-groups",
      ],
    );
  }

  if (!NETWORKING_OPERATIONS.has(operation)) {
    throw new AxiError(
      `Unknown ec2 operation: ${operation}`,
      "USAGE_ERROR",
      [
        `Supported networking operations: ${[...NETWORKING_OPERATIONS].join(", ")}`,
        "Run `aws-axi ec2 --help` to see all options",
      ],
    );
  }

  const remainingArgs = args.slice(1);
  const { maxItems, rest: afterMaxItems } = parseMaxItems(remainingArgs);
  const { nextToken, rest: afterNextToken } = parseNextToken(afterMaxItems);

  // Guard: reject unrecognized flags
  const unknownFlags = afterNextToken.filter((a) => a.startsWith("-"));
  if (unknownFlags.length > 0) {
    throw new AxiError(
      `Unknown flag: ${unknownFlags[0] ?? ""}`,
      "USAGE_ERROR",
      ["Run `aws-axi ec2 --help` to see valid flags"],
    );
  }

  return ec2Run({
    operation: operation as Ec2NetworkingOperation,
    maxItems,
    nextToken,
    context,
  });
}
