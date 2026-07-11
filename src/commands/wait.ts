/**
 * `aws-axi wait` — first-class waiter primitive backed by botocore models.
 *
 * Wraps `aws <service> wait <waiter-name> [--flags]` and enriches the result
 * with model-derived metadata so the agent knows the polling budget up-front
 * and gets a definitive terminal outcome — success or structured failure —
 * instead of a raw exit code.
 *
 * Exported shape:
 *   waitRun(options)              → typed result (for testing / composition)
 *   waitCommand(args, context)    → AxiCliCommand adapter (for CLI)
 *   WAIT_HELP                     → help text string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import { awsRaw } from "../aws.js";
import { loadService, getWaiter, listWaiters } from "../model.js";
import { parseAwsError } from "../errors.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Structured result returned by a successful waiter execution. */
export interface WaitResult {
  /** Always `true` — confirms the resource reached the desired state. */
  readonly waited: true;
  /** The AWS service that owns this waiter (e.g. `"ec2"`, `"s3"`). */
  readonly service: string;
  /** Waiter name as it appears in `waiters-2.json` (e.g. `"instance-running"`). */
  readonly waiter: string;
  /** The underlying operation the waiter polls (e.g. `"DescribeInstances"`). */
  readonly targetOp: string;
  /** Total maximum wait time in seconds: `maxAttempts × delay`. */
  readonly budgetSeconds: number;
  /** Maximum number of polling attempts. */
  readonly polls: number;
  /** Seconds between each poll. */
  readonly pollIntervalSeconds: number;
}

/** Options for `waitRun`. */
export interface WaitRunOptions {
  /** AWS service name (e.g. `"ec2"`, `"s3"`). */
  readonly service: string;
  /** Waiter name as it appears in `waiters-2.json` (e.g. `"instance-running"`). */
  readonly waiterName: string;
  /** Pass-through flags forwarded verbatim to `aws <service> wait <waiter-name>`. */
  readonly flags: readonly string[];
  /** Per-call profile/region context. */
  readonly context?: AwsContext;
  /** Override the aws binary path — for testing via real stub scripts. */
  readonly binary?: string;
  /**
   * Override the botocore data directory — for testing via fixture snapshots.
   * Defaults to the installed aws CLI's botocore data path.
   */
  readonly dataDir?: string;
}

/** Options injected by tests into `waitCommand` (not exposed in production). */
export interface WaitCommandTestOptions {
  readonly binary?: string;
  readonly dataDir?: string;
}

// ── Help text ─────────────────────────────────────────────────────────────────

export const WAIT_HELP = `usage: aws-axi wait <service> <waiter-name> [--flags] [--profile <name>] [--region <region>]
Block until the named AWS waiter reaches its success state, then emit a
definitive result with polling budget metadata. Waiter definitions are read
from the installed aws CLI's botocore models (waiters-2.json).

args:
  <service>       AWS service name (e.g. ec2, s3, rds)
  <waiter-name>   Waiter name as reported by \`aws <service> wait help\`

flags:
  --profile <name>   AWS profile to use
  --region <region>  AWS region to use
  --help             Show this help

additional flags (e.g. --instance-ids, --bucket) are forwarded to the
underlying aws waiter command unchanged.

examples:
  aws-axi wait ec2 instance-running --instance-ids i-0123456789abcdef0
  aws-axi wait s3 bucket-exists --bucket my-bucket
  aws-axi wait rds db-instance-available --db-instance-identifier mydb
  aws-axi wait ec2 instance-running --profile prod --region us-east-1 --instance-ids i-xxx
`;

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Run a named AWS waiter, returning a structured result on success or throwing
 * a structured AxiError on timeout / failure acceptor / credential error.
 *
 * Steps:
 *   1. Load the botocore model for `service` and validate the waiter exists.
 *      If not, throw USAGE_ERROR listing available waiters.
 *   2. Shell to `aws <service> wait <waiterName> [...flags] --output json`
 *      via the exec seam (`awsRaw`).
 *   3. Exit 0 → return `WaitResult` enriched with model metadata.
 *   4. Non-zero exit → propagate well-known errors (no-credentials,
 *      auth-expired) or map to SERVICE_CLIENT_ERROR with budget context.
 */
export async function waitRun(options: WaitRunOptions): Promise<WaitResult> {
  // 1. Load model + validate waiter
  const model = loadService(options.service, { dataDir: options.dataDir });
  const waiterDef = getWaiter(model, options.waiterName);

  if (waiterDef === undefined) {
    const available = listWaiters(model);
    throw new AxiError(
      `Unknown waiter '${options.waiterName}' for service '${options.service}'`,
      "USAGE_ERROR",
      [
        `Available waiters for ${options.service}: ${available.join(", ")}`,
        `Run: aws-axi wait ${options.service} <waiter-name> [--flags]`,
      ],
    );
  }

  const budgetSeconds = waiterDef.delay * waiterDef.maxAttempts;

  // 2. Shell to `aws <service> wait <waiterName> [...flags]`
  //    awsRaw appends --output json (harmless for wait; produces no output).
  const result = await awsRaw(
    [options.service, "wait", options.waiterName, ...options.flags],
    { binary: options.binary, context: options.context },
  );

  // 3. Success
  if (result.exitCode === 0) {
    return Object.freeze({
      waited: true as const,
      service: options.service,
      waiter: options.waiterName,
      targetOp: waiterDef.operation,
      budgetSeconds,
      polls: waiterDef.maxAttempts,
      pollIntervalSeconds: waiterDef.delay,
    });
  }

  // 4. Non-zero — check for well-known taxonomy errors first
  const parsed = parseAwsError(result.stderr, result.exitCode);

  // Propagate: no-credentials, auth-expired, service-client-error, aws-not-installed
  if (parsed.code !== "UNKNOWN") {
    throw new AxiError(parsed.message, parsed.code, [...parsed.suggestions]);
  }

  // Waiter timeout or failure acceptor hit — structured error with budget context
  throw new AxiError(
    `Waiter '${options.waiterName}' for service '${options.service}' did not reach success state ` +
      `within budget: ${waiterDef.maxAttempts} polls × ${waiterDef.delay}s = ${budgetSeconds}s`,
    "SERVICE_CLIENT_ERROR",
    [
      `Polls ${waiterDef.operation} every ${waiterDef.delay}s, up to ${waiterDef.maxAttempts} times (${budgetSeconds}s total)`,
      `Resource may still be transitioning — retry or check its current state`,
    ],
  );
}

// ── CLI adapter ───────────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter.
 * Args are pre-stripped of --profile/--region by the CLI wrapper.
 * Expected shape: `[<service>, <waiter-name>, ...pass-through-flags]`
 *
 * The optional third `testOptions` parameter is only used in tests to inject
 * a stub binary and fixture dataDir without touching global state.
 */
export async function waitCommand(
  args: string[],
  context: AwsContext | undefined,
  testOptions?: WaitCommandTestOptions,
): Promise<Record<string, unknown>> {
  // We need at least 2 positional args: service and waiter-name.
  // Since pass-through flags can appear anywhere, we pick the first two
  // non-flag tokens as the positionals.
  const positionals = args.filter((a) => !a.startsWith("-"));

  if (positionals.length < 2) {
    throw new AxiError(
      `aws-axi wait requires <service> and <waiter-name>\nUsage: aws-axi wait <service> <waiter-name> [--flags]`,
      "USAGE_ERROR",
      [
        `Example: aws-axi wait ec2 instance-running --instance-ids i-0123456789abcdef0`,
        `Example: aws-axi wait s3 bucket-exists --bucket my-bucket`,
      ],
    );
  }

  const service = positionals[0] as string;
  const waiterName = positionals[1] as string;

  // Pass-through: everything after the first two positionals (in original order).
  // Slice after the second positional's position in args.
  const serviceIdx = args.indexOf(service);
  const waiterIdx = args.indexOf(waiterName, serviceIdx + 1);
  const passThrough = args.slice(waiterIdx + 1);

  const result = await waitRun({
    service,
    waiterName,
    flags: passThrough,
    context,
    binary: testOptions?.binary,
    dataDir: testOptions?.dataDir,
  });

  // Return as a plain index-compatible object for AxiRenderable compatibility.
  return {
    waited: result.waited,
    service: result.service,
    waiter: result.waiter,
    targetOp: result.targetOp,
    budgetSeconds: result.budgetSeconds,
    polls: result.polls,
    pollIntervalSeconds: result.pollIntervalSeconds,
  };
}
