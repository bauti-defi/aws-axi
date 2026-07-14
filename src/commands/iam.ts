/**
 * `aws-axi iam` — hand-polished IAM read commands.
 *
 * Mirrors `aws iam <operation>` names 1:1. Projects the verbose IAM JSON
 * down to the fields an agent actually needs (name, arn, id, dates, counts),
 * caps auto-pagination, and emits definitive empty states with suggestions.
 *
 * Supported operations:
 *   list-roles                        list IAM roles (paginated, capped)
 *   get-role <name>                   get a single role by name
 *   list-policies [--scope <scope>]   list IAM policies (paginated, capped)
 *   get-policy <arn>                  get a single policy by ARN
 *   list-attached-role-policies <role> list policies attached to a role
 *
 * Exported shape:
 *   iamRun({ op, args, context?, binary? })  → typed result (for testing)
 *   iamCommand(args, context)                → AxiCliCommand adapter
 *   IAM_HELP                                 → help string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import { awsJson } from "../aws.js";
import { fallThroughToEngine } from "../engine.js";
import { buildPassthrough, collectPassthroughFlags } from "../overlay-args.js";

// ---------------------------------------------------------------------------
// AWS raw response shapes (only fields we project or act on)
// ---------------------------------------------------------------------------

interface IamRawRole {
  readonly RoleName: string;
  readonly RoleId: string;
  readonly Arn: string;
  readonly CreateDate: string;
  readonly Description?: string;
  readonly MaxSessionDuration?: number;
}

interface IamRawPolicy {
  readonly PolicyName: string;
  readonly PolicyId: string;
  readonly Arn: string;
  readonly AttachmentCount: number;
  readonly UpdateDate: string;
}

interface IamRawAttachedPolicy {
  readonly PolicyName: string;
  readonly PolicyArn: string;
}

// NOTE: these interfaces reflect the REAL shape the AWS CLI emits under
// --max-items. The CLI's client-side paginator (botocore build_full_result)
// aggregates the result key and synthesises NextToken when more pages exist.
// It strips IsTruncated / Marker entirely — those fields are never present.
// Gate truncation on `NextToken !== undefined` alone.
interface IamListRolesResponse {
  readonly Roles: readonly IamRawRole[];
  readonly NextToken?: string;
}

interface IamGetRoleResponse {
  readonly Role: IamRawRole & {
    readonly AssumeRolePolicyDocument?: unknown;
    readonly Tags?: unknown;
    readonly Path?: string;
  };
}

interface IamListPoliciesResponse {
  readonly Policies: readonly IamRawPolicy[];
  readonly NextToken?: string;
}

interface IamGetPolicyResponse {
  readonly Policy: IamRawPolicy & {
    readonly Path?: string;
    readonly DefaultVersionId?: string;
    readonly IsAttachable?: boolean;
    readonly CreateDate?: string;
  };
}

interface IamListAttachedRolePoliciesResponse {
  readonly AttachedPolicies: readonly IamRawAttachedPolicy[];
  readonly NextToken?: string;
}

// ---------------------------------------------------------------------------
// Curated projections — the load-bearing fields only
// ---------------------------------------------------------------------------

interface CuratedRole {
  readonly name: string;
  readonly arn: string;
  readonly id: string;
  readonly created: string;
  readonly description?: string;
  readonly maxSessionDuration?: number;
}

interface CuratedPolicy {
  readonly name: string;
  readonly arn: string;
  readonly id: string;
  readonly attachedTo: number;
  readonly updated: string;
}

interface CuratedAttachedPolicy {
  readonly name: string;
  readonly arn: string;
}

// ---------------------------------------------------------------------------
// Operation type
// ---------------------------------------------------------------------------

export type IamOp =
  | "list-roles"
  | "get-role"
  | "list-policies"
  | "get-policy"
  | "list-attached-role-policies";

const VALID_OPS: readonly IamOp[] = [
  "list-roles",
  "get-role",
  "list-policies",
  "get-policy",
  "list-attached-role-policies",
];

export interface IamRunOptions {
  readonly op: IamOp;
  /** Remaining args after the operation name, e.g. ["my-role"] for get-role. */
  readonly args: readonly string[];
  readonly context?: AwsContext;
  /** Override the aws binary path. Used in tests via real stub scripts. */
  readonly binary?: string;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const IAM_HELP = `usage: aws-axi iam <operation> [args] [--profile <name>] [--region <region>]
Operations mirror \`aws iam <operation>\` names 1:1.

Any flag accepted by \`aws iam <operation>\` (e.g. --path-prefix, --filter,
--query) is forwarded verbatim to the underlying aws invocation — overlays
never restrict the input contract, only enrich the output.

operations[5] (enriched overlays):
  list-roles                               list IAM roles (paginated, capped at 100)
  get-role <name>                          get a role by name
  list-policies [--scope Local|AWS|All]    list IAM policies (default scope: Local)
  get-policy <policy-arn>                  get a policy by ARN
  list-attached-role-policies <role-name>  list policies attached to a role
  (any other iam operation falls through to the generic engine — run \`aws iam help\` to list all)

flags (overlay-specific):
  --profile <name>   AWS profile to use
  --region <region>  AWS region to use
  --next-token <tok> resume a truncated list (pass nextToken from prior result)
  --query <expr>     JMESPath expression; bypasses overlay projection, returns raw result
  --output           stripped (aws-axi always uses --output json internally)

examples:
  aws-axi iam list-roles
  aws-axi iam list-roles --path-prefix /engineering/   # forwarded to aws
  aws-axi iam list-roles --next-token <tok>
  aws-axi iam get-role my-role
  aws-axi iam get-role my-role --query Role.Arn        # JMESPath bypass
  aws-axi iam list-policies
  aws-axi iam list-policies --scope AWS
  aws-axi iam get-policy arn:aws:iam::aws:policy/AdministratorAccess
  aws-axi iam list-attached-role-policies my-role
`;

// ---------------------------------------------------------------------------
// Pagination-cap defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITEMS = "100";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectRole(r: IamRawRole): CuratedRole {
  const base: CuratedRole = {
    name: r.RoleName,
    arn: r.Arn,
    id: r.RoleId,
    created: r.CreateDate,
  };
  // Conditionally include optional fields to keep output minimal
  const withDesc =
    r.Description !== undefined
      ? { ...base, description: r.Description }
      : base;
  return r.MaxSessionDuration !== undefined
    ? { ...withDesc, maxSessionDuration: r.MaxSessionDuration }
    : withDesc;
}

function projectPolicy(p: IamRawPolicy): CuratedPolicy {
  return {
    name: p.PolicyName,
    arn: p.Arn,
    id: p.PolicyId,
    attachedTo: p.AttachmentCount,
    updated: p.UpdateDate,
  };
}

function projectAttachedPolicy(p: IamRawAttachedPolicy): CuratedAttachedPolicy {
  return { name: p.PolicyName, arn: p.PolicyArn };
}

/**
 * Parse a --next-token <value> flag from args.
 * Returns { token, remaining } where remaining has the flag + value removed.
 */
function extractNextToken(args: readonly string[]): {
  token: string | undefined;
  remaining: string[];
} {
  const remaining: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--next-token" && i + 1 < args.length) {
      token = args[i + 1];
      i++;
    } else if (arg.startsWith("--next-token=")) {
      token = arg.slice("--next-token=".length);
    } else {
      remaining.push(arg);
    }
  }
  return { token, remaining };
}

/**
 * Parse a --scope <value> flag from args.
 */
function extractScope(args: readonly string[]): {
  scope: string | undefined;
  remaining: string[];
} {
  const remaining: string[] = [];
  let scope: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--scope" && i + 1 < args.length) {
      scope = args[i + 1];
      i++;
    } else if (arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    } else {
      remaining.push(arg);
    }
  }
  return { scope, remaining };
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

async function runListRoles(
  args: readonly string[],
  context: AwsContext | undefined,
  binary: string | undefined,
): Promise<Record<string, unknown>> {
  const { token } = extractNextToken(args);
  // Forward unknown flags verbatim (superset contract: overlay never restricts input).
  const rawPassthrough = collectPassthroughFlags(args, ["--next-token"], undefined, { service: "iam", operation: "list-roles" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = ["iam", "list-roles", "--max-items", DEFAULT_MAX_ITEMS];
  if (token !== undefined) awsArgs.push("--starting-token", token);
  awsArgs.push(...passthrough);

  if (hasQuery) {
    // --query: aws CLI applies JMESPath before we see the result; bypass projection.
    return awsJson<Record<string, unknown>>(awsArgs, { binary, context });
  }

  const response = await awsJson<IamListRolesResponse>(awsArgs, {
    binary,
    context,
  });

  const roles = response.Roles.map(projectRole);
  const result: Record<string, unknown> = {
    roles,
    count: roles.length,
  };

  if (response.NextToken !== undefined) {
    result["truncated"] = true;
    result["nextToken"] = response.NextToken;
    result["help"] = [
      `Showing ${roles.length} roles. More available — pass --next-token to continue.`,
      `aws-axi iam list-roles --next-token ${response.NextToken}`,
    ];
  } else if (roles.length === 0) {
    result["help"] = [
      "No IAM roles found in this account.",
      "Create one with: aws iam create-role --role-name <name> --assume-role-policy-document <doc>",
    ];
  }

  return result;
}

async function runGetRole(
  args: readonly string[],
  context: AwsContext | undefined,
  binary: string | undefined,
): Promise<Record<string, unknown>> {
  const roleName = args[0];
  if (!roleName || roleName.startsWith("-")) {
    throw new AxiError(
      "get-role requires a role name: aws-axi iam get-role <name>",
      "USAGE_ERROR",
      ["Example: aws-axi iam get-role my-lambda-role"],
    );
  }

  // Forward unknown flags from args after the positional (superset contract).
  const rawPassthrough = collectPassthroughFlags(args.slice(1), [], undefined, { service: "iam", operation: "get-role" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = ["iam", "get-role", "--role-name", roleName, ...passthrough];

  if (hasQuery) {
    // --query: aws CLI applies JMESPath; bypass overlay projection.
    return awsJson<Record<string, unknown>>(awsArgs, { binary, context });
  }

  const response = await awsJson<IamGetRoleResponse>(awsArgs, { binary, context });

  return { role: projectRole(response.Role) };
}

async function runListPolicies(
  args: readonly string[],
  context: AwsContext | undefined,
  binary: string | undefined,
): Promise<Record<string, unknown>> {
  const { scope, remaining: afterScope } = extractScope(args);
  const { token } = extractNextToken(afterScope);
  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(args, ["--scope", "--next-token"], undefined, { service: "iam", operation: "list-policies" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = ["iam", "list-policies", "--max-items", DEFAULT_MAX_ITEMS];
  if (scope !== undefined) awsArgs.push("--scope", scope);
  if (token !== undefined) awsArgs.push("--starting-token", token);
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, { binary, context });
  }

  const response = await awsJson<IamListPoliciesResponse>(awsArgs, {
    binary,
    context,
  });

  const policies = response.Policies.map(projectPolicy);
  const result: Record<string, unknown> = {
    policies,
    count: policies.length,
  };

  if (response.NextToken !== undefined) {
    result["truncated"] = true;
    result["nextToken"] = response.NextToken;
    const scopeFlag = scope !== undefined ? ` --scope ${scope}` : "";
    result["help"] = [
      `Showing ${policies.length} policies. More available — pass --next-token to continue.`,
      `aws-axi iam list-policies${scopeFlag} --next-token ${response.NextToken}`,
    ];
  } else if (policies.length === 0) {
    const scopeNote =
      scope === undefined
        ? " (default scope is Local — try --scope AWS or --scope All)"
        : "";
    result["help"] = [
      `No IAM policies found${scopeNote}.`,
      "Run `aws-axi iam list-policies --scope All` to include AWS-managed policies",
    ];
  }

  return result;
}

async function runGetPolicy(
  args: readonly string[],
  context: AwsContext | undefined,
  binary: string | undefined,
): Promise<Record<string, unknown>> {
  const policyArn = args[0];
  if (!policyArn || policyArn.startsWith("-")) {
    throw new AxiError(
      "get-policy requires a policy ARN: aws-axi iam get-policy <arn>",
      "USAGE_ERROR",
      [
        "Example: aws-axi iam get-policy arn:aws:iam::aws:policy/AdministratorAccess",
        "Run `aws-axi iam list-policies` to see available ARNs",
      ],
    );
  }

  const rawPassthrough = collectPassthroughFlags(args.slice(1), [], undefined, { service: "iam", operation: "get-policy" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = ["iam", "get-policy", "--policy-arn", policyArn, ...passthrough];

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, { binary, context });
  }

  const response = await awsJson<IamGetPolicyResponse>(awsArgs, { binary, context });

  return { policy: projectPolicy(response.Policy) };
}

async function runListAttachedRolePolicies(
  args: readonly string[],
  context: AwsContext | undefined,
  binary: string | undefined,
): Promise<Record<string, unknown>> {
  const roleName = args[0];
  if (!roleName || roleName.startsWith("-")) {
    throw new AxiError(
      "list-attached-role-policies requires a role name: aws-axi iam list-attached-role-policies <name>",
      "USAGE_ERROR",
      ["Example: aws-axi iam list-attached-role-policies my-task-role"],
    );
  }

  const { token } = extractNextToken(args.slice(1));
  const rawPassthrough = collectPassthroughFlags(args.slice(1), ["--next-token"], undefined, { service: "iam", operation: "list-attached-role-policies" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = [
    "iam",
    "list-attached-role-policies",
    "--role-name",
    roleName,
    "--max-items",
    DEFAULT_MAX_ITEMS,
  ];
  if (token !== undefined) awsArgs.push("--starting-token", token);
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, { binary, context });
  }

  const response = await awsJson<IamListAttachedRolePoliciesResponse>(awsArgs, {
    binary,
    context,
  });

  const attachedPolicies = response.AttachedPolicies.map(projectAttachedPolicy);
  const result: Record<string, unknown> = {
    roleName,
    attachedPolicies,
    count: attachedPolicies.length,
  };

  if (response.NextToken !== undefined) {
    result["truncated"] = true;
    result["nextToken"] = response.NextToken;
    result["help"] = [
      `Showing ${attachedPolicies.length} attached policies. More available — pass --next-token to continue.`,
      `aws-axi iam list-attached-role-policies ${roleName} --next-token ${response.NextToken}`,
    ];
  } else if (attachedPolicies.length === 0) {
    result["help"] = [
      `No policies attached to role: ${roleName}`,
      `Attach one with: aws iam attach-role-policy --role-name ${roleName} --policy-arn <arn>`,
    ];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Core logic — testable without the CLI layer.
 * Dispatches to the appropriate IAM operation handler.
 */
export async function iamRun(
  options: IamRunOptions,
): Promise<Record<string, unknown>> {
  const { op, args, context, binary } = options;

  switch (op) {
    case "list-roles":
      return runListRoles(args, context, binary);
    case "get-role":
      return runGetRole(args, context, binary);
    case "list-policies":
      return runListPolicies(args, context, binary);
    case "get-policy":
      return runGetPolicy(args, context, binary);
    case "list-attached-role-policies":
      return runListAttachedRolePolicies(args, context, binary);
  }
}

/**
 * AxiCliCommand adapter.
 * Args are pre-stripped of --profile/--region by the CLI wrapper.
 * The first remaining arg is the IAM operation name.
 */
export async function iamCommand(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const opArg = args[0];

  if (!opArg || opArg === "--help" || opArg === "-h") {
    throw new AxiError(IAM_HELP, "USAGE_ERROR");
  }

  if (!VALID_OPS.includes(opArg as IamOp)) {
    // Not in the overlay's hot-path — delegate to the model-driven engine.
    // The engine validates against the botocore iam model and surfaces a clean
    // USAGE_ERROR for ops that are genuinely unknown to AWS.
    return fallThroughToEngine("iam", opArg, args.slice(1), context);
  }

  return iamRun({
    op: opArg as IamOp,
    args: args.slice(1),
    context,
  });
}
