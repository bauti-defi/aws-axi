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
 * Return the value only if it is a non-empty, non-whitespace-only string.
 * Used to filter `export AWS_PROFILE=` (empty string) so it doesn't silently
 * suppress lower-precedence env vars like AWS_AXI_PROFILE.
 */
function nonEmpty(value: string | undefined): string | undefined {
  // Treat whitespace-only values as absent (same as undefined). But do NOT trim
  // a padded value like " dev " — the raw `aws` CLI rejects it with "The config
  // profile ( dev ) could not be found"; aws-axi must agree, not silently succeed.
  return value?.trim() ? value : undefined;
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
      // Precedence: --profile flag > AWS_PROFILE > AWS_DEFAULT_PROFILE > AWS_AXI_PROFILE
      // Empty/whitespace-only env values are treated as absent so a stray
      // `export AWS_PROFILE=` does not silently disable AWS_AXI_PROFILE.
      profile:
        profile ??
        nonEmpty(process.env["AWS_PROFILE"]) ??
        nonEmpty(process.env["AWS_DEFAULT_PROFILE"]) ??
        nonEmpty(process.env["AWS_AXI_PROFILE"]),
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
