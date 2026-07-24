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
import {
  buildPassthrough,
  collectPassthroughFlags,
  extractPositionals,
  locateFlag,
} from "../overlay-args.js";

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
  --query <expr>     JMESPath expression; bypasses overlay projection, returns raw result.
                     Output is unbounded (botocore auto-pages all results; default cap
                     suppressed). To bound output, pass --max-items N.
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
// Shared helper: positional-or-flag arg resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a key argument that real `aws` accepts only as a named flag
 * (e.g. --role-name, --policy-arn) but aws-axi historically also accepted
 * as a bare positional.
 *
 * Under ADR-0002 (superset input contract), BOTH forms are accepted:
 *   <value>              bare positional — aws-axi extension; real aws rejects this
 *   --<flag> <value>     flag form       — real aws's only accepted form
 *   --<flag>=<value>     equals form     — real aws's equals variant
 *
 * Conflict (both positional AND flag in the same call) → USAGE_ERROR that
 * names both conflicting values so the caller knows what to fix.
 *
 * Uses extractPositionals() so flag values (e.g. "my-role" in "--role-name
 * my-role") are never mis-identified as the positional argument.
 *
 * ── Where #63 plugs in ────────────────────────────────────────────────────────
 * lambda get-function has the identical defect: it accepts --function-name
 * positionally only (src/commands/lambda.ts:426–432). Once overlay-args.ts
 * (PR #86) is no longer contended, move this helper there and close #63 with:
 *
 *   const fnName = resolveKeyArg({
 *     args: options.args, flagName: "--function-name",
 *     label: "function name/ARN",
 *     examples: ["Usage: aws-axi lambda get-function <name>",
 *                "Usage: aws-axi lambda get-function --function-name <name>"],
 *   });
 *
 * @param args      Full args array for the operation (before any slicing).
 * @param flagName  Flag name in --kebab-case (e.g. "--role-name").
 * @param label     Human-readable description for error messages.
 * @param examples  Hint strings appended to every USAGE_ERROR.
 * @returns         Resolved value string.
 */
function resolveKeyArg({
  args,
  flagName,
  label,
  examples,
}: {
  readonly args: readonly string[];
  readonly flagName: string;
  readonly label: string;
  readonly examples: readonly string[];
}): string {
  // extractPositionals() correctly skips flag values (e.g. "my-role" in
  // "--role-name my-role" is NOT returned as a positional — it's consumed
  // as the value of the preceding flag). See overlay-args.ts for the full
  // algorithm.
  const positionals = extractPositionals(args);
  const positional = positionals[0] as string | undefined;

  // Flag form: --flag value  or  --flag=value
  const flagLoc = locateFlag(args, flagName);
  const flagValue = flagLoc?.value;

  // Conflict: both forms in the same call — real aws can't hit this (it
  // doesn't accept positionals for these ops) so we define the policy:
  // USAGE_ERROR naming both values, forcing the caller to pick one form.
  if (positional !== undefined && flagValue !== undefined) {
    throw new AxiError(
      `Conflicting ${label}: positional '${positional}' and ${flagName} '${flagValue}'. Provide one form only.`,
      "USAGE_ERROR",
      [...examples],
    );
  }

  const value = positional ?? flagValue;
  if (value === undefined) {
    throw new AxiError(
      `${label} is required: provide it positionally or as ${flagName}`,
      "USAGE_ERROR",
      [...examples],
    );
  }

  return value;
}

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

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active. JMESPath projects NextToken away, so the cap would cause silent
  // truncation with no signal. Without --max-items, botocore auto-pages the
  // complete result. If the caller explicitly passed --max-items it flows via
  // passthrough (not an owned flag here) and wins.
  const awsArgs: string[] = ["iam", "list-roles"];
  if (!hasQuery) {
    awsArgs.push("--max-items", DEFAULT_MAX_ITEMS);
  }
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
  // Accept both positional form ("my-role") and flag form ("--role-name my-role").
  // --role-name is added to ownedFlagNames so collectPassthroughFlags excludes it
  // from passthrough (it is already forwarded explicitly in awsArgs below).
  const roleName = resolveKeyArg({
    args,
    flagName: "--role-name",
    label: "get-role role name",
    examples: [
      "Example: aws-axi iam get-role my-role",
      "Example: aws-axi iam get-role --role-name my-role",
    ],
  });

  // Forward unknown flags verbatim (superset contract). Pass full args — the
  // positional is skipped as a bare token; --role-name is owned and excluded.
  const rawPassthrough = collectPassthroughFlags(args, ["--role-name"], undefined, { service: "iam", operation: "get-role" });
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

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active. Same reasoning as list-roles: explicit --max-items flows via passthrough.
  const awsArgs: string[] = ["iam", "list-policies"];
  if (!hasQuery) {
    awsArgs.push("--max-items", DEFAULT_MAX_ITEMS);
  }
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
  // Accept both positional form ("arn:aws:iam::...") and flag form ("--policy-arn arn:...").
  // --policy-arn is added to ownedFlagNames so collectPassthroughFlags excludes it
  // from passthrough (it is already forwarded explicitly in awsArgs below).
  const policyArn = resolveKeyArg({
    args,
    flagName: "--policy-arn",
    label: "get-policy policy ARN",
    examples: [
      "Example: aws-axi iam get-policy arn:aws:iam::aws:policy/AdministratorAccess",
      "Example: aws-axi iam get-policy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess",
      "Run `aws-axi iam list-policies` to see available ARNs",
    ],
  });

  // Forward unknown flags verbatim (superset contract). Pass full args — the
  // positional is skipped as a bare token; --policy-arn is owned and excluded.
  const rawPassthrough = collectPassthroughFlags(args, ["--policy-arn"], undefined, { service: "iam", operation: "get-policy" });
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
  // Accept both positional form ("my-role") and flag form ("--role-name my-role").
  // --role-name is added to ownedFlagNames so collectPassthroughFlags excludes it
  // from passthrough (it is already forwarded explicitly in awsArgs below).
  const roleName = resolveKeyArg({
    args,
    flagName: "--role-name",
    label: "list-attached-role-policies role name",
    examples: [
      "Example: aws-axi iam list-attached-role-policies my-task-role",
      "Example: aws-axi iam list-attached-role-policies --role-name my-task-role",
    ],
  });

  // Pass full args — extractNextToken only keys on --next-token so the positional
  // or --role-name tokens are harmlessly ignored. collectPassthroughFlags skips
  // bare positionals and both owned flag names.
  const { token } = extractNextToken(args);
  const rawPassthrough = collectPassthroughFlags(args, ["--next-token", "--role-name"], undefined, { service: "iam", operation: "list-attached-role-policies" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active. Explicit --max-items flows via passthrough (not an owned flag here).
  const awsArgs: string[] = ["iam", "list-attached-role-policies", "--role-name", roleName];
  if (!hasQuery) {
    awsArgs.push("--max-items", DEFAULT_MAX_ITEMS);
  }
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
