/**
 * `aws-axi wait` — first-class waiter primitive backed by botocore models.
 *
 * Wraps `aws <service> wait <waiter-name> [--flags]` and enriches the result
 * with model-derived metadata so the agent knows the polling budget up-front
 * and gets a definitive terminal outcome — success or structured failure.
 *
 * CASING CONTRACT (mirrors the AWS CLI 1:1):
 *   - Users provide waiter names in kebab-case: `instance-running`, `bucket-exists`
 *   - botocore `waiters-2.json` keys are PascalCase: `InstanceRunning`, `BucketExists`
 *   - The shell invocation uses the user's kebab-case (what `aws … wait` accepts)
 *   - The model lookup converts via a reverse map: kebab → PascalCase
 *   - Error messages and available-waiters listings use kebab-case throughout
 *
 * Exported shape:
 *   waitRun(options)              → typed result (for testing / composition)
 *   waitCommand(args, context)    → AxiCliCommand adapter (for CLI)
 *   WAIT_HELP                     → help text string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import { awsRaw } from "../aws.js";
import { loadService, getWaiter, pascalToKebab, type ServiceModel } from "../model.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Structured result returned by a successful waiter execution. */
export interface WaitResult {
  /** Always `true` — confirms the resource reached the desired state. */
  readonly waited: true;
  /** The AWS service that owns this waiter (e.g. `"ec2"`, `"s3"`). */
  readonly service: string;
  /**
   * Waiter name in kebab-case — the user-facing CLI form (e.g. `"instance-running"`).
   * This is what you pass back to `aws-axi wait` in a retry.
   */
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
  /** Waiter name in kebab-case, as accepted by the AWS CLI (e.g. `"instance-running"`). */
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
  /**
   * Override path to ~/.aws/config for NO_PROFILE_SELECTED diagnostics.
   * Defaults to the real ~/.aws/config. Injectable for tests so they never
   * read the developer's actual config file.
   */
  readonly configPath?: string;
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

Waiter names use kebab-case, matching the AWS CLI convention:
  aws-axi wait ec2 instance-running   (not InstanceRunning)
  aws-axi wait s3 bucket-exists       (not BucketExists)

args:
  <service>       AWS service name (e.g. ec2, s3, rds)
  <waiter-name>   Waiter name in kebab-case (e.g. instance-running, bucket-exists)

flags:
  --profile <name>   AWS profile to use
  --region <region>  AWS region to use
  --help             Show this help

Additional flags (e.g. --instance-ids, --bucket) are forwarded to the
underlying aws waiter command unchanged.

examples:
  aws-axi wait ec2 instance-running --instance-ids i-0123456789abcdef0
  aws-axi wait s3 bucket-exists --bucket my-bucket
  aws-axi wait rds db-instance-available --db-instance-identifier mydb
  aws-axi wait ec2 instance-running --profile prod --region us-east-1 --instance-ids i-xxx
`;

/**
 * Build a reverse map from kebab-case CLI names to their raw PascalCase
 * botocore keys for a given service model.
 *
 * This map is the authoritative lookup table for resolving what a user types
 * (`instance-running`) to the botocore key (`InstanceRunning`) that
 * `getWaiter` requires. Building the reverse map (rather than inverting the
 * kebab→pascal conversion) is essential for lossless round-trips of names
 * that contain acronyms (e.g. `DBInstanceAvailable`).
 */
function buildKebabWaiterMap(model: ServiceModel): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const pascalKey of model.waiters.keys()) {
    map.set(pascalToKebab(pascalKey), pascalKey);
  }
  return map;
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Run a named AWS waiter, returning a structured result on success or throwing
 * a structured AxiError on timeout / failure acceptor / credential error.
 *
 * Steps:
 *   1. Load the botocore model for `service` and resolve the user's kebab
 *      waiter name to the PascalCase key via the reverse map.
 *      If not found, throw USAGE_ERROR listing available waiters in kebab-case.
 *   2. Shell to `aws <service> wait <waiterName> [...flags]`
 *      via the exec seam (`awsRaw`). The kebab name is passed unchanged —
 *      that is what the AWS CLI accepts.
 *   3. Exit 0 → return `WaitResult` enriched with model metadata.
 *   4. Non-zero exit:
 *      a. Propagate well-known taxonomy errors (no-credentials, auth-expired).
 *      b. "terminal failure state" stderr → SERVICE_CLIENT_ERROR indicating a
 *         failure acceptor was matched (no retry advice — agent could loop).
 *      c. Otherwise (max-attempts exhausted) → SERVICE_CLIENT_ERROR with budget
 *         context and retry advice.
 */
export async function waitRun(options: WaitRunOptions): Promise<WaitResult> {
  // 1. Load model + resolve kebab → PascalCase via reverse map
  const model = loadService(options.service, { dataDir: options.dataDir });
  const kebabMap = buildKebabWaiterMap(model);
  const pascalKey = kebabMap.get(options.waiterName);

  if (pascalKey === undefined) {
    const availableKebab = [...kebabMap.keys()].sort();
    throw new AxiError(
      `Unknown waiter '${options.waiterName}' for service '${options.service}'`,
      "USAGE_ERROR",
      [
        `Available waiters for ${options.service}: ${availableKebab.join(", ")}`,
        `Run: aws-axi wait ${options.service} <waiter-name> [--flags]`,
      ],
    );
  }

  // Must exist — we just confirmed the key via the map
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const waiterDef = getWaiter(model, pascalKey)!;
  const budgetSeconds = waiterDef.delay * waiterDef.maxAttempts;

  // 2. Shell to `aws <service> wait <waiterName> [...flags]`
  //    awsRaw appends --output json (harmless for wait; produces no output).
  //    The kebab waiter name is passed unchanged — that is what `aws` expects.
  const result = await awsRaw(
    [options.service, "wait", options.waiterName, ...options.flags],
    { binary: options.binary, context: options.context, configPath: options.configPath },
  );

  // 3. Success
  if (result.exitCode === 0) {
    return Object.freeze({
      waited: true as const,
      service: options.service,
      waiter: options.waiterName, // return the kebab form the user typed
      targetOp: waiterDef.operation,
      budgetSeconds,
      polls: waiterDef.maxAttempts,
      pollIntervalSeconds: waiterDef.delay,
    });
  }

  // 4a. Propagate well-known taxonomy errors (no-credentials, auth-expired, …)
  // awsRaw populates result.error with the enriched ParsedAwsError (including
  // the NO_CREDENTIALS → NO_PROFILE_SELECTED upgrade) so no separate parse call
  // is needed.
  const parsed = result.error!;
  if (parsed.code !== "UNKNOWN") {
    throw new AxiError(parsed.message, parsed.code, [...parsed.suggestions]);
  }

  const botoMsg = result.stderr.trim();

  // 4b. Terminal failure acceptor hit — resource reached a permanent bad state.
  //     Do NOT advise retry: the agent could loop forever on a terminated instance.
  if (/terminal failure state/i.test(botoMsg)) {
    throw new AxiError(
      `Waiter '${options.waiterName}' for service '${options.service}' reached a terminal failure state`,
      "SERVICE_CLIENT_ERROR",
      [
        botoMsg, // preserve botocore's exact message (includes the matched state)
        `The resource reached a permanent non-success state — check its current state`,
      ],
    );
  }

  // 4c. Timeout: max attempts exhausted (or unknown non-zero exit).
  throw new AxiError(
    `Waiter '${options.waiterName}' for service '${options.service}' did not reach success state ` +
      `within budget: ${waiterDef.maxAttempts} polls × ${waiterDef.delay}s = ${budgetSeconds}s`,
    "SERVICE_CLIENT_ERROR",
    [
      `Polls ${waiterDef.operation} every ${waiterDef.delay}s, up to ${waiterDef.maxAttempts} times (${budgetSeconds}s total)`,
      `Resource may still be transitioning — retry with a longer budget or check its current state`,
      ...(botoMsg ? [`AWS: ${botoMsg}`] : []),
    ],
  );
}

// ── CLI adapter ───────────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter.
 * Args are pre-stripped of --profile/--region by the CLI wrapper.
 * Expected shape: `[<service>, <waiter-name-kebab>, ...pass-through-flags]`
 *
 * The optional third `testOptions` parameter is only used in tests to inject
 * a stub binary and fixture dataDir without touching global state.
 */
export async function waitCommand(
  args: string[],
  context: AwsContext | undefined,
  testOptions?: WaitCommandTestOptions,
): Promise<Record<string, unknown>> {
  // Pick the first two non-flag tokens as <service> and <waiter-name>.
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

  // Everything after the second positional's position in the original args is
  // forwarded as pass-through flags (preserving flag-value pairs in order).
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
