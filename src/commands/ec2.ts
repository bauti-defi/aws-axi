/**
 * `aws-axi ec2` — EC2 networking reads (Tier 0) + EC2 instance reads (Tier 1).
 *
 * Networking overlays (slice #7):
 *   describe-vpcs, describe-subnets, describe-security-groups
 *
 * Instance overlays (slice #11):
 *   describe-instances — projected to id/state/type/AZ/IP/name-tag and enriched
 *   with resolve-sg (SG names), resolve-subnet (subnet name), resolve-role
 *   (instance-profile role name) so agents see human names, not raw IDs/ARNs.
 *
 * Pagination is capped via --max-items; truncation is gated ONLY on the
 * synthesized botocore NextToken (never on native Reservations-level tokens).
 *
 * Exported shape:
 *   ec2Run({ operation, maxItems, nextToken, context, binary })  → typed object
 *   ec2Command(args, context)                                    → AxiCliCommand adapter
 *   EC2_HELP                                                     → help text
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import { awsJson } from "../aws.js";
import { fallThroughToEngine } from "../engine.js";
import { buildPassthrough, stripOutputFlag } from "../overlay-args.js";
import { resolveSg } from "../resolve/sg.js";
import { resolveSubnet } from "../resolve/subnet.js";
import { resolveRole } from "../resolve/role.js";

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

/** Tier-1 instance operations (slice #11). */
export type Ec2InstancesOperation = "describe-instances";

/** Union of all operations this module handles. */
export type Ec2Operation = Ec2NetworkingOperation | Ec2InstancesOperation;

/** All EC2 operations this overlay handles (networking + instances). */
const ALL_EC2_OPERATIONS: ReadonlySet<string> = new Set<Ec2Operation>([
  "describe-vpcs",
  "describe-subnets",
  "describe-security-groups",
  "describe-instances",
]);

export interface Ec2RunOptions {
  readonly operation: Ec2Operation;
  /** Max items to return. Defaults to DEFAULT_MAX_ITEMS (50). */
  readonly maxItems?: number;
  /** Pagination resume token from a previous truncated result. */
  readonly nextToken?: string;
  readonly context?: AwsContext;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  /**
   * Unknown flags (and their values) collected from the user's argv AFTER the
   * overlay has consumed its own known flags (--max-items, --next-token).
   * Forwarded verbatim to the underlying aws invocation — never rejected.
   *
   * Examples: ["--filters", "Name=tag:Name,Values=foo"]
   *           ["--filters=Name=instance-state-name,Values=running"]
   *           ["--dry-run"]
   */
  readonly passthrough?: readonly string[];
  /**
   * True when --query was present in the user's argv.
   * When set, the overlay bypasses its curated projection and returns the raw
   * queried result from the aws CLI (JMESPath is applied by aws, not by us).
   */
  readonly hasQuery?: boolean;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const EC2_HELP = `usage: aws-axi ec2 <operation> [--profile <name>] [--region <region>] [flags]

operations[4] (enriched overlays — curated output with resolved names):
  describe-vpcs, describe-subnets, describe-security-groups, describe-instances
  (any other ec2 operation falls through to the generic engine — run \`aws ec2 help\` to list all)

overlay-specific flags:
  --max-items <n>      Max items to return per page (default: 50)
  --next-token <tok>   Resume pagination from this token

passthrough flags:
  Any flag the real \`aws ec2\` CLI accepts for an operation is accepted and
  forwarded to the underlying aws invocation. Server-side filtering + enriched
  output work together: --filters, --instance-ids, --dry-run, etc. all pass through.

  --query <jmespath>   JMESPath expression applied by aws CLI; the overlay's curated
                       projection is bypassed when --query is present and the raw
                       queried result is returned instead.
  --output <format>    Stripped (output is always TOON; --output has no effect).

global flags:
  --profile <name>     AWS profile to use (default: AWS_PROFILE env or "default")
  --region <region>    AWS region to use (default: AWS_REGION / AWS_DEFAULT_REGION env)

examples:
  aws-axi ec2 describe-vpcs
  aws-axi ec2 describe-vpcs --profile prod --region us-west-2
  aws-axi ec2 describe-subnets
  aws-axi ec2 describe-subnets --max-items 10
  aws-axi ec2 describe-security-groups
  aws-axi ec2 describe-instances
  aws-axi ec2 describe-instances --filters "Name=instance-state-name,Values=running"
  aws-axi ec2 describe-instances --filters "Name=tag:Name,Values=my-server-*" --max-items 10
  aws-axi ec2 describe-instances --query 'Reservations[].Instances[].InstanceId'
  aws-axi ec2 describe-regions
  aws-axi ec2 describe-availability-zones
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
      ...(options.passthrough ?? []),
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
      ...(options.passthrough ?? []),
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
      ...(options.passthrough ?? []),
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
// Raw AWS response types (EC2 instances)
// ---------------------------------------------------------------------------

interface AwsInstanceState {
  readonly Code: number;
  readonly Name: string;
}

interface AwsInstanceSgRef {
  readonly GroupId: string;
  readonly GroupName: string;
}

interface AwsIamInstanceProfile {
  readonly Arn: string;
  readonly Id: string;
}

interface AwsInstance {
  readonly InstanceId: string;
  readonly InstanceType: string;
  readonly State: AwsInstanceState;
  readonly Placement: { readonly AvailabilityZone: string };
  readonly PrivateIpAddress?: string;
  readonly PublicIpAddress?: string;
  readonly SubnetId?: string;
  readonly VpcId?: string;
  readonly SecurityGroups?: readonly AwsInstanceSgRef[];
  readonly IamInstanceProfile?: AwsIamInstanceProfile;
  readonly Tags?: readonly AwsTag[];
}

interface AwsReservation {
  readonly ReservationId: string;
  readonly OwnerId: string;
  readonly Instances: readonly AwsInstance[];
}

interface DescribeInstancesResponse {
  readonly Reservations: readonly AwsReservation[];
  /**
   * Synthesized by the botocore --max-items paginator.
   * Gate truncation ONLY on this field — never on reservation-level tokens.
   */
  readonly NextToken?: string;
}

// ---------------------------------------------------------------------------
// Curated output type (EC2 instances)
// ---------------------------------------------------------------------------

interface InstanceSummary {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly type: string;
  readonly az: string;
  readonly privateIp: string | null;
  readonly publicIp: string | null;
  /** Resolved subnet name (from resolve-subnet). Null when unresolvable. */
  readonly subnet: string | null;
  /** Resolved SG names (from resolve-sg). Empty when instance has no SGs. */
  readonly securityGroups: string[];
  /** Role name from instance-profile ARN (from resolve-role). Null when absent. */
  readonly role: string | null;
}

// ---------------------------------------------------------------------------
// Instances implementation
// ---------------------------------------------------------------------------

async function describeInstances(
  options: Ec2RunOptions,
): Promise<Record<string, unknown>> {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const resp = await awsJson<DescribeInstancesResponse>(
    [
      "ec2",
      "describe-instances",
      ...buildPaginationArgs({ maxItems, nextToken: options.nextToken }),
      ...(options.passthrough ?? []),
    ],
    { binary: options.binary, context: options.context },
  );

  // Flatten Reservations[].Instances[] into a single list.
  const rawInstances: AwsInstance[] = resp.Reservations.flatMap(
    (r) => [...r.Instances],
  );

  // Gate truncation on synthesized NextToken only — never on native fields.
  const truncated = resp.NextToken !== undefined;

  if (rawInstances.length === 0) {
    return {
      instances: [],
      count: 0,
      help: [
        "No EC2 instances found in the current region.",
        "Launch one with: aws ec2 run-instances --image-id <ami-id> --instance-type <type>",
        "Or check a different region with: aws-axi ec2 describe-instances --region <region>",
      ],
    };
  }

  // Enrich each instance concurrently.
  const instances: InstanceSummary[] = await Promise.all(
    rawInstances.map(async (inst): Promise<InstanceSummary> => {
      const resolveOpts = { binary: options.binary, context: options.context };

      // Resolve SG names in parallel.
      const sgNames = await Promise.all(
        (inst.SecurityGroups ?? []).map(async (sg) => {
          const resolved = await resolveSg({ id: sg.GroupId, ...resolveOpts });
          return resolved?.name ?? sg.GroupName ?? sg.GroupId;
        }),
      );

      // Resolve subnet name.
      const subnetName = inst.SubnetId
        ? await resolveSubnet({ id: inst.SubnetId, ...resolveOpts }).then(
            (r) => r?.name ?? inst.SubnetId ?? null,
          )
        : null;

      // Resolve role name from instance-profile ARN (pure parse — no network).
      const roleName = inst.IamInstanceProfile?.Arn
        ? await resolveRole({
            nameOrArn: inst.IamInstanceProfile.Arn,
            ...resolveOpts,
          }).then((r) => r?.name ?? null)
        : null;

      return {
        id: inst.InstanceId,
        name: nameTag(inst.Tags, inst.InstanceId),
        state: inst.State.Name,
        type: inst.InstanceType,
        az: inst.Placement.AvailabilityZone,
        privateIp: inst.PrivateIpAddress ?? null,
        publicIp: inst.PublicIpAddress ?? null,
        subnet: subnetName ?? null,
        securityGroups: sgNames,
        role: roleName,
      };
    }),
  );

  const result: Record<string, unknown> = {
    instances,
    count: instances.length,
  };

  if (truncated) {
    result["truncated"] = true;
    result["nextToken"] = resp.NextToken;
    result["help"] = [
      `Showing ${instances.length} instances (more available).`,
      `Continue with: aws-axi ec2 describe-instances --next-token ${resp.NextToken ?? ""}`,
    ];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Core logic — testable without the CLI layer
// ---------------------------------------------------------------------------

/**
 * Run an EC2 operation and return the curated result object.
 *
 * When `options.hasQuery` is true, bypasses the overlay's curated projection
 * and returns the raw result from the aws CLI (JMESPath applied by aws CLI).
 *
 * Throws AxiError (USAGE_ERROR) for unknown operations; propagates AxiError
 * from the exec seam for credential and service errors.
 */
export async function ec2Run(
  options: Ec2RunOptions,
): Promise<Record<string, unknown>> {
  const op = options.operation as string;

  if (!ALL_EC2_OPERATIONS.has(op)) {
    throw new AxiError(
      `Unknown ec2 operation: ${op}. Run \`aws-axi ec2 --help\` to see supported operations.`,
      "USAGE_ERROR",
      [
        `Supported operations: ${[...ALL_EC2_OPERATIONS].join(", ")}`,
        "For other EC2 operations, use the generic engine: aws ec2 <operation>",
      ],
    );
  }

  // Normalize passthrough: strip --output so the exec seam (which always
  // appends --output json) never sees a duplicate --output flag.
  const normalizedOptions: Ec2RunOptions =
    options.passthrough !== undefined
      ? { ...options, passthrough: stripOutputFlag(options.passthrough) }
      : options;

  // --query bypass: JMESPath is applied by the aws CLI before we see the JSON,
  // so the response shape is unknown and the overlay CANNOT safely project it.
  // Forward everything to aws and return the raw queried result.
  //
  // ADR-0002 cap bypass: when --query is active and the caller did NOT supply
  // an explicit --max-items, skip the overlay's default cap. JMESPath projects
  // NextToken away; the default cap would cause silent truncation with no signal.
  // Without --max-items, botocore auto-pages to completion. An explicit
  // --max-items from the caller (normalizedOptions.maxItems !== undefined) is
  // always honored — last-wins semantics stay in place.
  if (normalizedOptions.hasQuery === true) {
    const awsArgs: string[] = ["ec2", op];
    // Only inject --max-items when the user explicitly provided it.
    if (normalizedOptions.maxItems !== undefined) {
      awsArgs.push("--max-items", String(normalizedOptions.maxItems));
    }
    if (normalizedOptions.nextToken !== undefined) {
      awsArgs.push("--starting-token", normalizedOptions.nextToken);
    }
    awsArgs.push(...(normalizedOptions.passthrough ?? []));
    return awsJson<Record<string, unknown>>(awsArgs, {
      binary: normalizedOptions.binary,
      context: normalizedOptions.context,
    }) as Promise<Record<string, unknown>>;
  }

  switch (normalizedOptions.operation) {
    case "describe-vpcs":
      return describeVpcs(normalizedOptions);
    case "describe-subnets":
      return describeSubnets(normalizedOptions);
    case "describe-security-groups":
      return describeSecurityGroups(normalizedOptions);
    case "describe-instances":
      return describeInstances(normalizedOptions);
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
        `Supported operations: ${[...ALL_EC2_OPERATIONS].join(", ")}`,
      ],
    );
  }

  if (!ALL_EC2_OPERATIONS.has(operation)) {
    // Not in the overlay's hot-path — delegate to the model-driven engine.
    // The engine validates against the botocore ec2 model and surfaces a clean
    // USAGE_ERROR for ops that are genuinely unknown to AWS.
    return fallThroughToEngine("ec2", operation, args.slice(1), context);
  }

  const remainingArgs = args.slice(1);
  const { maxItems, rest: afterMaxItems } = parseMaxItems(remainingArgs);
  const { nextToken, rest: afterNextToken } = parseNextToken(afterMaxItems);

  // Collect passthrough: everything left after the overlay's own flags are consumed.
  // Unrecognised flags are forwarded verbatim to the underlying aws invocation —
  // never rejected. --output is stripped (exec seam always appends --output json).
  const { passthrough, hasQuery } = buildPassthrough(afterNextToken);

  return ec2Run({
    operation: operation as Ec2Operation,
    maxItems,
    nextToken,
    passthrough,
    hasQuery,
    context,
  });
}
