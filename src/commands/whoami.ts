/**
 * `aws-axi whoami` — fused identity primitive.
 *
 * Calls `aws sts get-caller-identity` and fuses the result with the
 * resolved profile, region, and detected credential source into one
 * curated TOON block. This is the #1 agent primitive: one command answers
 * "who am I, where am I, and how am I authenticated?"
 *
 * Exported shape:
 *   whoamiRun({ context, binary })  → typed object (for testing / composition)
 *   whoamiCommand(args, context)    → AxiCliCommand adapter (for CLI)
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import { awsJson } from "../aws.js";

interface StsCallerIdentity {
  readonly Account: string;
  readonly Arn: string;
  readonly UserId: string;
}

export interface WhoamiData {
  readonly account: string;
  readonly arn: string;
  readonly userId: string;
  readonly profile: string;
  readonly region: string;
  readonly credentialSource: string;
}

export interface WhoamiResult {
  readonly whoami: WhoamiData;
}

export interface WhoamiRunOptions {
  readonly context?: AwsContext;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
}

export const WHOAMI_HELP = `usage: aws-axi whoami [--profile <name>] [--region <region>]
Fuse sts get-caller-identity with resolved profile, region, and credential source.

flags:
  --profile <name>   AWS profile to use (default: AWS_PROFILE env or "default")
  --region <region>  AWS region to use (default: AWS_REGION / AWS_DEFAULT_REGION env)

examples:
  aws-axi whoami
  aws-axi whoami --profile prod
  aws-axi whoami --region us-west-2
  aws-axi whoami --profile staging --region eu-west-1
`;

/**
 * Detect the likely credential source by inspecting the execution context
 * and environment. Ordered by specificity: explicit env key injection >
 * IRSA/web-identity > assume-role > named profile > default chain.
 */
function detectCredentialSource(context: AwsContext | undefined): string {
  if (process.env["AWS_ACCESS_KEY_ID"]) {
    return "env-keys";
  }
  if (process.env["AWS_WEB_IDENTITY_TOKEN_FILE"]) {
    return "web-identity";
  }
  if (process.env["AWS_ROLE_ARN"]) {
    return "assume-role";
  }
  const profile = context?.profile ?? process.env["AWS_PROFILE"];
  if (profile) {
    return `profile:${profile}`;
  }
  return "default";
}

/**
 * Core logic — testable without the CLI layer.
 * Throws AxiError (NO_CREDENTIALS / AUTH_EXPIRED / SERVICE_CLIENT_ERROR) on
 * any aws failure; the CLI formats and exits appropriately.
 */
export async function whoamiRun(options: WhoamiRunOptions): Promise<WhoamiResult> {
  const identity = await awsJson<StsCallerIdentity>(
    ["sts", "get-caller-identity"],
    {
      binary: options.binary,
      context: options.context,
    },
  );

  const effectiveProfile =
    options.context?.profile ?? process.env["AWS_PROFILE"] ?? "default";
  const effectiveRegion =
    options.context?.region ??
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"] ??
    "unknown";
  const credentialSource = detectCredentialSource(options.context);

  return {
    whoami: {
      account: identity.Account,
      arn: identity.Arn,
      userId: identity.UserId,
      profile: effectiveProfile,
      region: effectiveRegion,
      credentialSource,
    },
  };
}

/**
 * AxiCliCommand adapter.
 * Args are pre-stripped of --profile/--region by the CLI wrapper; whoami
 * takes no positional args, so any remaining arg is an error.
 */
export async function whoamiCommand(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  // Guard: reject unrecognized positional args (flags already stripped by wrapper).
  const positional = args.filter((a) => a !== "" && !a.startsWith("-"));
  if (positional.length > 0) {
    throw new AxiError(
      `Unknown argument: ${positional[0] ?? ""}`,
      "USAGE_ERROR",
      [`Run \`aws-axi whoami --help\` to see valid flags`],
    );
  }

  const { whoami } = await whoamiRun({ context });

  // Return as a plain index-compatible object for AxiRenderable compatibility.
  const record: Record<string, unknown> = {
    whoami: {
      account: whoami.account,
      arn: whoami.arn,
      userId: whoami.userId,
      profile: whoami.profile,
      region: whoami.region,
      credentialSource: whoami.credentialSource,
    },
  };
  return record;
}
