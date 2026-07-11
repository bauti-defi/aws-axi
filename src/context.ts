/**
 * AwsContext — the per-invocation profile/region tuple.
 *
 * Resolved once at the top of each `runAxiCli` dispatch from the user's
 * argv, then threaded through every command handler and exec-seam call.
 * The exec seam injects profile/region into the child process's environment
 * so the child `aws` binary sees them without argv flag duplication.
 */
export interface AwsContext {
  readonly profile: string | undefined;
  readonly region: string | undefined;
}

/**
 * Parse --profile / --region global flags from argv, falling back to the
 * canonical AWS environment variables. Returns the effective context AND the
 * argv with those flags removed so command handlers see only their own flags.
 */
export function stripContextArgs(args: readonly string[]): {
  readonly strippedArgs: string[];
  readonly context: AwsContext;
} {
  const stripped: string[] = [];
  let profile: string | undefined;
  let region: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";

    if (arg === "--profile" && i + 1 < args.length) {
      profile = args[i + 1];
      i++;
    } else if (arg.startsWith("--profile=") && arg.length > "--profile=".length) {
      profile = arg.slice("--profile=".length);
    } else if (arg === "--region" && i + 1 < args.length) {
      region = args[i + 1];
      i++;
    } else if (arg.startsWith("--region=") && arg.length > "--region=".length) {
      region = arg.slice("--region=".length);
    } else {
      stripped.push(arg);
    }
  }

  return {
    strippedArgs: stripped,
    context: {
      profile: profile ?? process.env["AWS_PROFILE"] ?? undefined,
      region:
        region ??
        process.env["AWS_REGION"] ??
        process.env["AWS_DEFAULT_REGION"] ??
        undefined,
    },
  };
}

/** Resolve an AwsContext from the full argv (used as runAxiCli's resolveContext). */
export function resolveAwsContext(args: readonly string[]): AwsContext {
  return stripContextArgs(args).context;
}
