/**
 * CLI entry — wires commands through axi-sdk-js `runAxiCli`.
 *
 * Responsibilities:
 *   1. Register `whoami`, `setup`, and the home view.
 *   2. Provide a custom `formatError` that uses aws-axi's exit-code taxonomy
 *      (252/253/254/255) rather than axi-sdk-js's generic 1/2.
 *   3. Strip --profile/--region global flags from args before each command
 *      handler sees them (context carries them instead).
 *   4. Wrap `commands` in a Proxy so any service without a hand-polished overlay
 *      falls through to the model-driven generic engine instead of erroring.
 *      Hand-polished overlays always take precedence.
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
import { s3Command, S3_HELP } from "./commands/s3.js";
import { iamCommand, IAM_HELP } from "./commands/iam.js";
import { logsCommand, LOGS_HELP } from "./commands/logs.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";
import { ssmCommand, SSM_HELP } from "./commands/ssm.js";
import { secretsCommand, SECRETS_HELP } from "./commands/secrets.js";
import { waitCommand, WAIT_HELP } from "./commands/wait.js";
import { lambdaCommand, LAMBDA_HELP } from "./commands/lambda.js";
import { engineRun } from "./engine.js";

export const DESCRIPTION =
  "Agent-ergonomic wrapper around the AWS CLI. Prefer this over `aws` for AWS operations.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: aws-axi [command] [args] [flags]
commands[12]:
  (none)=dashboard, whoami, ec2, kms, s3, iam, logs, setup, ssm, secretsmanager (alias: secrets), wait, lambda
  (any other AWS service name routes through the generic engine — ~18k ops covered)
flags[3]:
  --profile <name>, --region <region>, --help, -v/-V/--version
examples:
  aws-axi
  aws-axi whoami
  aws-axi iam list-roles
  aws-axi iam get-role my-role
  aws-axi whoami --profile prod
  aws-axi whoami --region us-east-1
  aws-axi ec2 describe-vpcs
  aws-axi ec2 describe-subnets
  aws-axi ec2 describe-security-groups
  aws-axi kms list-keys
  aws-axi kms describe-key alias/my-key
  aws-axi s3 ls
  aws-axi s3 ls s3://my-bucket/prefix/
  aws-axi logs tail /aws/lambda/my-function
  aws-axi logs describe-log-groups --prefix /aws/lambda
  aws-axi setup hooks
  aws-axi ssm get-parameter /my/app/db-password
  aws-axi ssm get-parameter /my/app/db-password --reveal
  aws-axi secretsmanager list-secrets
  aws-axi secretsmanager get-secret-value prod/my-app/api-key --reveal
  aws-axi wait ec2 instance-running --instance-ids i-0123456789abcdef0
  aws-axi wait s3 bucket-exists --bucket my-bucket
  aws-axi lambda list-functions
  aws-axi lambda get-function my-function
  aws-axi lambda invoke --function-name my-function
  aws-axi sqs list-queues
  aws-axi rds describe-db-instances
`;

const COMMAND_HELP: Record<string, string> = {
  whoami: WHOAMI_HELP,
  ec2: EC2_HELP,
  kms: KMS_HELP,
  s3: S3_HELP,
  iam: IAM_HELP,
  logs: LOGS_HELP,
  setup: SETUP_HELP,
  ssm: SSM_HELP,
  secretsmanager: SECRETS_HELP,
  secrets: SECRETS_HELP,
  wait: WAIT_HELP,
  lambda: LAMBDA_HELP,
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

/**
 * Build a command handler for a generic (non-overlay) service via the
 * model-driven engine. The returned handler follows the AxiCliCommand contract:
 * it receives `args` (pre-stripped of --profile/--region by withContextStrip)
 * where `args[0]` is the operation and `args.slice(1)` are the remaining flags.
 */
function makeEngineHandler(service: string): AxiCliCommand<AwsContext> {
  return (args: string[], context: AwsContext | undefined) => {
    const operation = args[0];
    if (operation === undefined || operation.startsWith("-")) {
      throw new AxiError(
        `${service}: operation required. Usage: aws-axi ${service} <operation> [args]`,
        "USAGE_ERROR",
        [`Run \`aws ${service} help\` to list available operations.`],
      );
    }
    return engineRun({
      service,
      operation,
      args: args.slice(1),
      context,
    });
  };
}

/**
 * Hand-polished overlay commands — these always take precedence over the
 * generic engine. Services NOT in this map fall through to makeEngineHandler.
 */
const OVERLAY_COMMANDS: Record<string, AxiCliCommand<AwsContext>> = {
  whoami: withContextStrip(whoamiCommand),
  ec2: withContextStrip(ec2Command),
  kms: withContextStrip(kmsCommand),
  s3: withContextStrip(s3Command),
  iam: withContextStrip(iamCommand),
  logs: withContextStrip(logsCommand),
  setup: withContextStrip(setupCommand),
  ssm: withContextStrip(ssmCommand),
  secretsmanager: withContextStrip(secretsCommand),
  secrets: withContextStrip(secretsCommand),
  wait: withContextStrip(waitCommand),
  lambda: withContextStrip((args, context) => lambdaCommand(args, context)),
};

/**
 * Keys that must NEVER be intercepted by the engine Proxy.
 *
 * - "update": reserved by runAxiCli for self-update; it gates on `!options.commands.update`.
 *   If the Proxy returned a truthy handler here, the self-update check would always be
 *   bypassed. The Proxy must return `undefined` so runAxiCli's gate works correctly.
 * - "then" / "catch" / "finally": if the Proxy returned handlers for these, the commands
 *   object would be a thenable, causing `Promise.resolve(commands)` to spin recursively
 *   and breaking any async code that touches the commands map.
 */
const PROXY_DENYLIST = new Set<string>(["update", "then", "catch", "finally"]);

/**
 * Build the command dispatch map: a Proxy over the overlay record that returns
 * a model-driven engine handler for any service not covered by a hand overlay.
 *
 * The Proxy intercepts `commands[service]` lookups. When `service` has an
 * overlay handler, it returns that. For any other string key, it returns a
 * handler closure that captures the service name and dispatches via engineRun.
 *
 * This gives full ~18k-operation coverage on day one with zero hand-coding per
 * service, while letting overlays shadow the engine on their specific services.
 */
function buildCommandsProxy(): Record<string, AxiCliCommand<AwsContext>> {
  return new Proxy(OVERLAY_COMMANDS, {
    get(
      target: Record<string, AxiCliCommand<AwsContext>>,
      prop: string | symbol,
      receiver: unknown,
    ): AxiCliCommand<AwsContext> | undefined {
      // Non-string keys (Symbol.toPrimitive etc.) — delegate normally.
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver) as
          | AxiCliCommand<AwsContext>
          | undefined;
      }

      // Denylist: reserved keys must NOT produce an engine handler.
      if (PROXY_DENYLIST.has(prop)) {
        return undefined;
      }

      // Overlay takes precedence.
      const overlay = Reflect.get(target, prop, receiver) as
        | AxiCliCommand<AwsContext>
        | undefined;
      if (overlay !== undefined) {
        return overlay;
      }

      // Unknown service → generic engine handler with context-strip wrapper.
      return withContextStrip(makeEngineHandler(prop));
    },
  }) as Record<string, AxiCliCommand<AwsContext>>;
}

export async function main(options: {
  argv?: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
} = {}): Promise<void> {
  // Patch process.argv[1] so axi-sdk-js's homeHeaderOutput banner shows the
  // POSIX sh launcher (dist/bin/aws-axi) rather than the .js module path
  // (dist/bin/aws-axi.js) that Bun receives after `exec bun --no-env-file`.
  // Without this, the banner's `bin:` field would advertise aws-axi.js —
  // teaching downstream agents to invoke it directly, which bypasses
  // --no-env-file and re-opens issue #32.  The launcher sets AWS_AXI_BIN to
  // its own resolved path before exec-ing Bun; we consume it here.
  const _launcherBin = process.env["AWS_AXI_BIN"];
  if (_launcherBin !== undefined && _launcherBin.length > 0) {
    process.argv[1] = _launcherBin;
  }
  await runAxiCli<AwsContext>({
    ...(options.argv ? { argv: options.argv } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: withContextStrip(homeCommand),
    commands: buildCommandsProxy(),
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
