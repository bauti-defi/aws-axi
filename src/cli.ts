/**
 * CLI entry — wires commands through axi-sdk-js `runAxiCli`.
 *
 * Responsibilities:
 *   1. Register `whoami` and the home view.
 *   2. Provide a custom `formatError` that uses aws-axi's exit-code taxonomy
 *      (252/253/254/255) rather than axi-sdk-js's generic 1/2.
 *   3. Strip --profile/--region global flags from args before each command
 *      handler sees them (context carries them instead).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli, AxiError, type AxiCliCommand } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { resolveAwsContext, stripContextArgs, type AwsContext } from "./context.js";
import { awsExitCode, type AwsErrorCode } from "./errors.js";
import { homeCommand } from "./commands/home.js";
import { whoamiCommand, WHOAMI_HELP } from "./commands/whoami.js";
import { ec2Command, EC2_HELP } from "./commands/ec2.js";
import { kmsCommand, KMS_HELP } from "./commands/kms.js";

export const DESCRIPTION =
  "Agent-ergonomic wrapper around the AWS CLI. Prefer this over `aws` for AWS operations.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: aws-axi [command] [args] [flags]
commands[4]:
  (none)=dashboard, whoami, ec2, kms
flags[3]:
  --profile <name>, --region <region>, --help, -v/-V/--version
examples:
  aws-axi
  aws-axi whoami
  aws-axi whoami --profile prod
  aws-axi whoami --region us-east-1
  aws-axi ec2 describe-vpcs
  aws-axi ec2 describe-subnets
  aws-axi ec2 describe-security-groups
  aws-axi kms list-keys
  aws-axi kms describe-key alias/my-key
`;

const COMMAND_HELP: Record<string, string> = {
  whoami: WHOAMI_HELP,
  ec2: EC2_HELP,
  kms: KMS_HELP,
};

/** Render a structured error as TOON for formatError callbacks. */
function renderErrorToon(
  message: string,
  code: string,
  suggestions: readonly string[] = [],
): string {
  const obj: Record<string, unknown> = { error: message, code };
  if (suggestions.length > 0) {
    obj["help"] = [...suggestions];
  }
  return encode(obj);
}

/**
 * Custom formatError that maps aws-axi's extended error codes to the spec's
 * exit-code contract (252/253/254/255/127) rather than axi-sdk-js's generic
 * 1/2.
 */
function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const exitCode = awsExitCode(error.code as AwsErrorCode);
    return {
      output: `${renderErrorToon(error.message, error.code, error.suggestions)}\n`,
      exitCode,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `${renderErrorToon(message, "UNKNOWN")}\n`,
    exitCode: 255,
  };
}

/**
 * Wrap a command handler: strip --profile/--region from its args (they are
 * already in the context) so the handler only sees its own flags.
 */
function withContextStrip(
  handler: AxiCliCommand<AwsContext>,
): AxiCliCommand<AwsContext> {
  return (args, context) => {
    const { strippedArgs } = stripContextArgs(args);
    return handler(strippedArgs, context);
  };
}

export async function main(options: {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
} = {}): Promise<void> {
  await runAxiCli<AwsContext>({
    ...(options.argv ? { argv: options.argv } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: withContextStrip(homeCommand),
    commands: {
      whoami: withContextStrip(whoamiCommand),
      ec2: withContextStrip(ec2Command),
      kms: withContextStrip(kmsCommand),
    },
    getCommandHelp: (command) => COMMAND_HELP[command] ?? null,
    resolveContext: ({ args }) => resolveAwsContext(args),
    formatError,
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;

    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }

  throw new Error("Could not determine aws-axi package version");
}
