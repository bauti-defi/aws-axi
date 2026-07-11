/**
 * Home view — shown when `aws-axi` is called with no command.
 *
 * Attempts to resolve current identity via `sts get-caller-identity`.
 * On credentials failure, surfaces an actionable setup hint instead of
 * an error so the agent always gets a useful starting context.
 */
import type { AwsContext } from "../context.js";
import { whoamiRun } from "./whoami.js";

export async function homeCommand(
  _args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  try {
    const { whoami } = await whoamiRun({ context });
    return {
      identity: {
        account: whoami.account,
        arn: whoami.arn,
        profile: whoami.profile,
        region: whoami.region,
      },
      help: [
        "Run `aws-axi whoami` for full identity details including credential source",
        "Run `aws-axi <service> <operation>` to execute any AWS operation",
        "Run `aws-axi --help` to see all available commands",
      ],
    };
  } catch {
    // No credentials or expired token — show setup guidance rather than an error.
    return {
      status: "not authenticated",
      help: [
        "Run `aws sso login` to authenticate via SSO",
        "Or run `aws configure` to set static credentials",
        "Run `aws-axi whoami` once authenticated to verify identity",
      ],
    };
  }
}
