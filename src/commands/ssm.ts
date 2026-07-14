/**
 * `aws-axi ssm` — SSM overlay.
 *
 * Mirrors `aws ssm <op>` 1:1 for covered operations. Projects to curated TOON
 * with values REDACTED by default, capped pagination, definitive empty states,
 * KMS alias enrichment on describe-parameters, and unescaped command output.
 *
 * Operations:
 *   run                       Send command + wait + return stdout/stderr (NEW)
 *   get-command-invocation    Enriched; unescapes output; --wait to poll (NEW)
 *   get-parameter             Get a single parameter (value redacted by default)
 *   get-parameters            Get multiple parameters by name (values redacted)
 *   get-parameters-by-path    Get all parameters under a path prefix (values redacted)
 *   describe-parameters       List parameter metadata; resolves KMS alias where present
 *
 * Use --reveal to display actual values for SSM parameters.
 *
 * Exports:
 *   ssmRun(options)       → typed SsmRunResult (testing / composition)
 *   ssmCommand(args, ctx) → AxiCliCommand adapter (CLI dispatch)
 *   SSM_HELP              → help text string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import type { AwsRunOptions } from "../aws.js";
import { awsJson } from "../aws.js";
import { resolveKey } from "../resolve/key.js";
import { fallThroughToEngine } from "../engine.js";
import { collectPassthroughFlags, buildPassthrough } from "../overlay-args.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REDACTED = "<redacted>";
const MAX_ITEMS_DEFAULT = 50;

const KNOWN_SUBCOMMANDS = new Set([
  "run",
  "get-command-invocation",
  "get-parameter",
  "get-parameters",
  "get-parameters-by-path",
  "describe-parameters",
]);

// Default polling config for `ssm run` and `get-command-invocation --wait`.
const POLL_INITIAL_MS = 500;
const POLL_MAX_MS = 5_000;
const POLL_MULTIPLIER = 1.5;

/** SSM invocation status values that indicate a terminal state (polling done). */
const SSM_TERMINAL_STATES = new Set([
  "Success",
  "Failed",
  "TimedOut",
  "Cancelled",
  "Undeliverable",
  "DeliveryTimedOut",
  "Cancelling",  // practically terminal
]);

/**
 * Subset of terminal states that represent AWS-level delivery failures —
 * SSM never ran the shell command on the instance. Exit 254 (SERVICE_CLIENT_ERROR).
 *
 * Exit code contract for ssm run / get-command-invocation (ssh/docker exec semantics):
 *   0       = success (remote exit 0, or non-terminal status — see below)
 *   1..249  = remote shell exit code, propagated verbatim
 *   250     = -1 sentinel in an unexpected terminal context (safety net; rare)
 *   254     = delivery failure: TimedOut, Undeliverable, Cancelled, etc.
 */
const SSM_DELIVERY_FAILURE_STATES = new Set([
  "TimedOut",
  "Undeliverable",
  "DeliveryTimedOut",
  "Cancelled",
  "Cancelling",
]);

/**
 * Non-terminal SSM statuses: command is still running or queued.
 * `get-command-invocation` without --wait may return these. They MUST exit 0
 * so that `set -e` polling loops (`until aws-axi ssm get-command-invocation ...`)
 * don't abort on a normal mid-flight response.
 * ResponseCode is -1 for all non-terminal states; we must not map that -1 to
 * exit 250 or any non-zero code.
 */
const SSM_NON_TERMINAL_STATES = new Set([
  "Pending",
  "InProgress",
  "Delayed",
  "Waiting",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ─── Raw AWS response shapes ──────────────────────────────────────────────────

interface RawSsmParameter {
  readonly Name: string;
  readonly Type: string;
  readonly Value: string;
  readonly Version: number;
  readonly LastModifiedDate: string;
  readonly ARN: string;
  readonly DataType: string;
}

interface RawGetParameterResponse {
  readonly Parameter: RawSsmParameter;
}

interface RawGetParametersResponse {
  readonly Parameters: readonly RawSsmParameter[];
  readonly InvalidParameters: readonly string[];
}

interface RawGetParametersByPathResponse {
  readonly Parameters: readonly RawSsmParameter[];
  readonly NextToken?: string;
}

interface RawParameterMetadata {
  readonly Name: string;
  readonly Type: string;
  readonly KeyId?: string;
  readonly LastModifiedDate: string;
  readonly Version: number;
  readonly Description?: string;
  readonly ARN: string;
  readonly DataType: string;
  readonly Tier: string;
}

interface RawDescribeParametersResponse {
  readonly Parameters: readonly RawParameterMetadata[];
  readonly NextToken?: string;
}

interface RawSendCommandResponse {
  readonly Command: {
    readonly CommandId: string;
  };
}

interface RawGetCommandInvocationResponse {
  readonly CommandId: string;
  readonly InstanceId: string;
  readonly DocumentName?: string;
  readonly Status: string;
  readonly StatusDetails: string;
  /** Remote exit code. -1 when SSM did not execute the command (timeout, delivery failure). */
  readonly ResponseCode: number;
  readonly StandardOutputContent: string;
  readonly StandardErrorContent: string;
  readonly ExecutionElapsedTime?: string;
}

// ─── Public result shapes ─────────────────────────────────────────────────────

export interface SsmParameterEntry {
  readonly name: string;
  readonly type: string;
  readonly version: number;
  readonly lastModified: string;
  readonly arn: string;
  readonly dataType: string;
  /** Actual value when --reveal is passed; "<redacted>" otherwise. */
  readonly value: string;
}

export interface SsmParameterMetadata {
  readonly name: string;
  readonly type: string;
  readonly version: number;
  readonly lastModified: string;
  readonly arn: string;
  readonly dataType: string;
  readonly description: string | undefined;
  readonly tier: string;
  /** Resolved KMS alias for SecureString parameters, undefined otherwise. */
  readonly kmsKeyAlias: string | undefined;
}

export interface SsmGetParameterResult {
  readonly parameter: SsmParameterEntry;
  /** Hint to use --reveal when value is redacted; absent when revealed. */
  readonly suggestion?: string;
}

export interface SsmGetParametersResult {
  readonly parameters: readonly SsmParameterEntry[];
  readonly invalidParameters: readonly string[];
  readonly count: string;
  readonly suggestion?: string;
}

export interface SsmGetParametersByPathResult {
  readonly parameters: readonly SsmParameterEntry[];
  readonly count: string;
  readonly nextToken?: string;
  readonly message?: string;
  readonly suggestion?: string;
}

export interface SsmDescribeParametersResult {
  readonly parameters: readonly SsmParameterMetadata[];
  readonly count: string;
  readonly nextToken?: string;
  readonly message?: string;
  readonly suggestion?: string;
}

/**
 * Result for `ssm run` — send-command + wait + structured output.
 *
 * stdout and stderr are presented as line arrays so each line renders on its
 * own row in TOON output instead of a single \\n-escaped quoted blob.
 */
export interface SsmRunCommandResult {
  readonly commandId: string;
  readonly instanceId: string;
  readonly status: string;
  /** Remote shell exit code. 0 = success, non-zero = shell failure. */
  readonly remoteExitCode: number;
  /** stdout lines (unescaped, trimmed trailing empty line). */
  readonly stdout: readonly string[];
  /** stderr lines (unescaped, trimmed trailing empty line). */
  readonly stderr: readonly string[];
}

/**
 * Enriched result for `ssm get-command-invocation`.
 * stdout/stderr are unescaped and split into line arrays.
 */
export interface SsmGetCommandInvocationResult {
  readonly commandId: string;
  readonly instanceId: string;
  readonly status: string;
  readonly statusDetails: string;
  /** Remote shell exit code. -1 when SSM did not execute the command. */
  readonly remoteExitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly executionElapsed: string;
}

/** Discriminated union returned by ssmRun. Raw Record when --query bypass is active. */
export type SsmRunResult =
  | SsmRunCommandResult
  | SsmGetCommandInvocationResult
  | SsmGetParameterResult
  | { readonly parameterList: SsmGetParametersResult }
  | { readonly parametersByPath: SsmGetParametersByPathResult }
  | { readonly parametersMeta: SsmDescribeParametersResult }
  | Record<string, unknown>;

export interface SsmRunOptions {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly binary?: string;
  readonly context?: AwsContext;
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export const SSM_HELP = `usage: aws-axi ssm <subcommand> [flags]

Any flag accepted by the underlying \`aws ssm\` operation (e.g. --recursive,
--filters, --with-decryption, --query) is forwarded verbatim — overlays never
restrict the input contract, only enrich the output.

subcommands (enriched overlays):
  run                                Send command + poll to completion + return output (NEW)
  get-command-invocation             Enriched; unescapes output; --wait to poll (NEW)
  describe-parameters                List parameter metadata (default when omitted)
  get-parameter <name>               Get one parameter; value is redacted by default
  get-parameters <n1> [n2...]        Get multiple parameters by name
  get-parameters-by-path <path>      Get all parameters under a path prefix
  (any other ssm subcommand falls through to the generic engine — run \`aws ssm help\` to list all)

flags (ssm run — required):
  --instance-ids <id>    Target EC2 instance ID (single instance)
  --commands <cmd>       Shell command to run on the instance (e.g. "docker ps")

flags (ssm run — optional):
  --timeout <secs>       Max seconds to wait for completion (default: 60)
                         On timeout, exits non-zero and prints the CommandId to resume with
                         get-command-invocation --command-id <id> --wait
  (any other flag is forwarded verbatim to aws ssm send-command; --query is not supported
   on ssm run since it is a composite operation with no single underlying aws call)

flags (get-command-invocation):
  --command-id <id>      SSM CommandId to query
  --instance-id <id>     Target instance ID
  --wait                 Poll to terminal state before returning (default: single call)
  --query <expr>         JMESPath; bypasses overlay projection, returns raw result

flags (overlay-specific):
  --profile <name>       AWS profile (inherited from global --profile)
  --region <region>      AWS region  (inherited from global --region)
  --reveal               Show actual parameter values (default: redacted; alias for --with-decryption)
  --query <expr>         JMESPath; bypasses overlay projection, returns raw result
  --output               stripped (aws-axi always uses --output json internally)

flags (list operations):
  --max-items <n>        Cap results per page (default: ${MAX_ITEMS_DEFAULT})
  --next-token <token>   Resume a previous paginated call

flags (get-parameter, get-parameters):
  --name <name>          Parameter name (alternative to positional)

flags (get-parameters-by-path):
  --path <path>          Parameter path prefix (alternative to positional)

exit codes (ssm run / get-command-invocation):
  0       = success (remote exit 0); also non-terminal status (InProgress, Pending…) for
            get-command-invocation without --wait — command still running, not an error
  1..249  = remote shell exit code propagated verbatim (ssh / docker exec semantics)
  250     = SSM -1 sentinel in an unexpected terminal context (safety net; rare in practice)
  252     = USAGE_ERROR — missing required flag
  254     = delivery failure — AWS never ran the command (TimedOut, Undeliverable, Cancelled…)

examples:
  aws-axi ssm run --instance-ids i-0abc123 --commands "docker ps"
  aws-axi ssm run --instance-ids i-0abc123 --commands "systemctl status nginx" --timeout 30
  aws-axi ssm get-command-invocation --command-id <id> --instance-id i-0abc123
  aws-axi ssm get-command-invocation --command-id <id> --instance-id i-0abc123 --wait
  aws-axi ssm
  aws-axi ssm get-parameter /my/app/db-password
  aws-axi ssm get-parameter /my/app/db-password --reveal
  aws-axi ssm get-parameters /my/app/db-password /my/app/api-key
  aws-axi ssm get-parameters-by-path /my/app --max-items 20
  aws-axi ssm get-parameters-by-path /my/app --recursive     # forwarded to aws
  aws-axi ssm describe-parameters
  aws-axi ssm describe-parameters --max-items 10 --next-token AQE...
  aws-axi ssm describe-parameters --filters Key=Path,Values=/my/app  # forwarded
`;

// ─── Arg-parsing helpers ──────────────────────────────────────────────────────

function extractFlag(args: readonly string[], flag: string): string | undefined {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === flag && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith(eqPrefix)) {
      return arg.slice(eqPrefix.length);
    }
  }
  return undefined;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/**
 * Boolean flags that take no separate value token.
 * Without this list, extractPositionals would incorrectly consume the first
 * positional after a boolean flag as that flag's value.
 */
const BOOLEAN_FLAGS = new Set([
  "--reveal",
  "--with-decryption",
  "--no-with-decryption",
  "--recursive",
  "--no-recursive",
]);

function extractPositionals(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      // --flag=value form: value embedded, no separate token
      continue;
    }
    if (arg.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg)) {
        // Boolean flag — no value token follows; skip only this token
        continue;
      }
      // Value flag — skip this AND the following value token
      i++;
    } else if (arg !== "") {
      result.push(arg);
    }
  }
  return result;
}

function extractMaxItems(args: readonly string[]): number {
  const raw = extractFlag(args, "--max-items");
  if (raw === undefined) return MAX_ITEMS_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new AxiError(
      `--max-items must be a positive integer, got: ${raw}`,
      "USAGE_ERROR",
      [`Run \`aws-axi ssm --help\` to see valid flags`],
    );
  }
  return parsed;
}

function countString(n: number, nextToken: string | undefined): string {
  if (nextToken !== undefined) {
    return `showing ${n} (truncated); next-token=${nextToken}`;
  }
  return `${n} total`;
}

function maybeRedact(value: string, reveal: boolean): string {
  return reveal ? value : REDACTED;
}

function toRunOpts(options: SsmRunOptions): AwsRunOptions {
  return { binary: options.binary, context: options.context };
}

function toResolveOpts(options: SsmRunOptions) {
  return { binary: options.binary, context: options.context };
}

function projectParameter(
  raw: RawSsmParameter,
  reveal: boolean,
): SsmParameterEntry {
  return {
    name: raw.Name,
    type: raw.Type,
    version: raw.Version,
    lastModified: raw.LastModifiedDate,
    arn: raw.ARN,
    dataType: raw.DataType,
    value: maybeRedact(raw.Value, reveal),
  };
}

// ─── Shared helpers for run + get-command-invocation ─────────────────────────

/**
 * Split SSM stdout/stderr content into a line array for TOON rendering.
 *
 * awsJson already JSON.parse()s the response, so content contains real
 * newlines — no additional unescaping is needed here. A second replace
 * for "\\n" → "\n" would corrupt Windows paths (C:\node\bin becomes
 * ["C:", "ode\bin"] because the `\n` pair is eaten as a newline separator).
 *
 * All we do is trim the single trailing newline that unix commands conventionally
 * append, then split on real newlines. The resulting string[] renders as
 * separate TOON array rows instead of a single quoted \n-blob.
 */
function toLines(content: string): readonly string[] {
  const trimmed = content.replace(/\n$/, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}

/**
 * Poll `get-command-invocation` until the invocation reaches a terminal state
 * or the deadline is exceeded.
 *
 * Back-off: starts at POLL_INITIAL_MS, multiplied by POLL_MULTIPLIER each
 * round, capped at POLL_MAX_MS. Never sleeps past the deadline.
 *
 * InvocationDoesNotExist handling:
 *   After send-command, SSM takes ~0.5–2 s to register the invocation. The
 *   first poll(s) may receive InvocationDoesNotExist — this is NOT a fatal
 *   error; it means "not registered yet". We treat it as non-terminal and
 *   retry until the deadline.
 *
 * CommandId invariant:
 *   Every failure path (timeout, fatal error) surfaces the CommandId so the
 *   operator can resume with `get-command-invocation --command-id <id> --wait`.
 *   A command running on a prod box must never be stranded without a handle.
 */
async function pollInvocation(
  commandId: string,
  instanceId: string,
  deadlineMs: number,
  options: SsmRunOptions,
): Promise<RawGetCommandInvocationResponse> {
  let intervalMs = POLL_INITIAL_MS;

  while (true) {
    // Deadline check BEFORE the poll so --timeout 0 reliably fails fast.
    if (Date.now() >= deadlineMs) {
      throw new AxiError(
        `ssm run timed out waiting for ${instanceId} to reach a terminal state — CommandId: ${commandId}`,
        "UNKNOWN",
        [
          `CommandId: ${commandId}`,
          `Resume with: aws-axi ssm get-command-invocation --command-id ${commandId} --instance-id ${instanceId} --wait`,
        ],
      );
    }

    let resp: RawGetCommandInvocationResponse;
    try {
      resp = await awsJson<RawGetCommandInvocationResponse>(
        [
          "ssm", "get-command-invocation",
          "--command-id", commandId,
          "--instance-id", instanceId,
        ],
        toRunOpts(options),
      );
    } catch (err) {
      // InvocationDoesNotExist is normal for ~0.5–2 s after send-command while
      // the invocation registers. Treat it as non-terminal and retry.
      if (err instanceof AxiError && err.message.includes("InvocationDoesNotExist")) {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) {
          throw new AxiError(
            `ssm run timed out before invocation registered — CommandId: ${commandId}`,
            "UNKNOWN",
            [
              `CommandId: ${commandId}`,
              `Resume with: aws-axi ssm get-command-invocation --command-id ${commandId} --instance-id ${instanceId} --wait`,
            ],
          );
        }
        await sleep(Math.min(intervalMs, remaining));
        intervalMs = Math.min(intervalMs * POLL_MULTIPLIER, POLL_MAX_MS);
        continue;
      }

      // Fatal error (auth, network, etc.) — re-throw with CommandId so the
      // operator can locate the running command.
      const origMsg = err instanceof Error ? err.message : String(err);
      throw new AxiError(
        `${origMsg} [CommandId: ${commandId}]`,
        "UNKNOWN",
        [
          `CommandId: ${commandId}`,
          `Resume with: aws-axi ssm get-command-invocation --command-id ${commandId} --instance-id ${instanceId} --wait`,
        ],
      );
    }

    if (SSM_TERMINAL_STATES.has(resp.Status)) {
      return resp;
    }

    // Non-terminal — sleep bounded by remaining deadline.
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      throw new AxiError(
        `ssm run timed out after polling — CommandId: ${commandId}`,
        "UNKNOWN",
        [
          `CommandId: ${commandId}`,
          `Resume with: aws-axi ssm get-command-invocation --command-id ${commandId} --instance-id ${instanceId} --wait`,
        ],
      );
    }
    await sleep(Math.min(intervalMs, remaining));
    intervalMs = Math.min(intervalMs * POLL_MULTIPLIER, POLL_MAX_MS);
  }
}

/** Project a raw GetCommandInvocation response to the enriched result shape. */
function projectInvocation(
  raw: RawGetCommandInvocationResponse,
): SsmGetCommandInvocationResult {
  return {
    commandId: raw.CommandId,
    instanceId: raw.InstanceId,
    status: raw.Status,
    statusDetails: raw.StatusDetails,
    remoteExitCode: raw.ResponseCode,
    stdout: toLines(raw.StandardOutputContent),
    stderr: toLines(raw.StandardErrorContent),
    executionElapsed: raw.ExecutionElapsedTime ?? "",
  };
}

// ─── ssm run ─────────────────────────────────────────────────────────────────

/**
 * `aws-axi ssm run` — send + wait + unescaped output in one call.
 *
 * Sends AWS-RunShellScript via send-command, polls to a terminal state, and
 * returns structured stdout/stderr/remoteExitCode.
 *
 * Exit code mapping (set by ssmCommand after inspecting the result):
 *   remoteExitCode = 0  → aws-axi exits 0 (clean success)
 *   remoteExitCode ≠ 0  → aws-axi exits 1 (REMOTE_EXEC_ERROR; not 254)
 *
 * `--query` is NOT forwarded to send-command because ssm run is a composite
 * operation (two AWS calls). Passing --query would break CommandId extraction
 * from the send-command response. Pipe `ssm run` output to `--query` via a
 * second aws-axi call if JMESPath projection is needed.
 */
async function runSsmRun(
  options: SsmRunOptions,
): Promise<SsmRunCommandResult | Record<string, unknown>> {
  const instanceId = extractFlag(options.args, "--instance-ids");
  const commands = extractFlag(options.args, "--commands");
  const timeoutStr = extractFlag(options.args, "--timeout") ?? "60";

  if (instanceId === undefined || instanceId === "") {
    throw new AxiError(
      "ssm run requires --instance-ids",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm run --instance-ids <instance-id> --commands <cmd>",
        "Example: aws-axi ssm run --instance-ids i-0abc123 --commands \"docker ps\"",
      ],
    );
  }

  if (commands === undefined || commands === "") {
    throw new AxiError(
      "ssm run requires --commands",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm run --instance-ids <instance-id> --commands <cmd>",
        "Example: aws-axi ssm run --instance-ids i-0abc123 --commands \"docker ps\"",
      ],
    );
  }

  const timeoutSecs = parseInt(timeoutStr, 10);
  if (isNaN(timeoutSecs) || timeoutSecs < 0) {
    throw new AxiError(
      `--timeout must be a non-negative integer (seconds), got: ${timeoutStr}`,
      "USAGE_ERROR",
      ["Example: aws-axi ssm run --instance-ids i-0abc123 --commands \"cmd\" --timeout 120"],
    );
  }

  // Collect passthrough for send-command.
  //
  // --query is added to ownedFlagNames so it is consumed here (not forwarded).
  // ssm run is a composite operation (send-command + poll); if --query were
  // forwarded to send-command, the aws CLI would apply JMESPath and return a
  // scalar instead of the full Command object, breaking CommandId extraction.
  //
  // --instance-ids, --commands, --timeout are overlay-owned value flags.
  const rawPassthrough = collectPassthroughFlags(
    options.args,
    ["--instance-ids", "--commands", "--timeout", "--query"],
    [],
    { service: "ssm", operation: "send-command" },
  );
  // buildPassthrough strips --output; --query is already absent (consumed above).
  const { passthrough } = buildPassthrough(rawPassthrough);

  // Deadline set BEFORE send-command so the total clock starts immediately.
  const deadlineMs = Date.now() + timeoutSecs * 1000;

  // ── 1. Send command ──────────────────────────────────────────────────────────
  // Use JSON.stringify for --parameters so commands with ", $, `, or \n are
  // safely encoded. String interpolation (`commands=["${commands}"]`) is broken
  // for any command containing a double-quote: the aws CLI JSON parser rejects it.
  const sendResp = await awsJson<RawSendCommandResponse>(
    [
      "ssm", "send-command",
      "--document-name", "AWS-RunShellScript",
      "--instance-ids", instanceId,
      "--parameters", JSON.stringify({ commands: [commands] }),
      ...passthrough,
    ],
    toRunOpts(options),
  );

  const commandId = sendResp.Command.CommandId;

  // ── 2. Poll to terminal state ────────────────────────────────────────────────
  const invocation = await pollInvocation(commandId, instanceId, deadlineMs, options);

  // ── 3. Build result ──────────────────────────────────────────────────────────
  return {
    commandId,
    instanceId,
    status: invocation.Status,
    remoteExitCode: invocation.ResponseCode,
    stdout: toLines(invocation.StandardOutputContent),
    stderr: toLines(invocation.StandardErrorContent),
  };
}

// ─── ssm get-command-invocation ───────────────────────────────────────────────

/**
 * Enriched `aws-axi ssm get-command-invocation` overlay.
 *
 * Improvements over the raw aws output:
 *   - stdout / stderr unescaped and split into line arrays (no \\n blob)
 *   - --wait: polls to terminal state using the same back-off as ssm run
 *   - --query: bypasses overlay projection (ADR-0002 superset contract)
 */
async function runGetCommandInvocation(
  options: SsmRunOptions,
): Promise<SsmGetCommandInvocationResult | Record<string, unknown>> {
  const commandId = extractFlag(options.args, "--command-id");
  const instanceId = extractFlag(options.args, "--instance-id");
  const doWait = hasFlag(options.args, "--wait");

  if (commandId === undefined || commandId === "") {
    throw new AxiError(
      "get-command-invocation requires --command-id",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm get-command-invocation --command-id <id> --instance-id <id>",
        "Hint: after ssm run times out, the CommandId is printed in the error output",
      ],
    );
  }

  if (instanceId === undefined || instanceId === "") {
    throw new AxiError(
      "get-command-invocation requires --instance-id",
      "USAGE_ERROR",
      ["Usage: aws-axi ssm get-command-invocation --command-id <id> --instance-id <id>"],
    );
  }

  // Collect passthrough for the underlying aws ssm get-command-invocation call.
  const rawPassthrough = collectPassthroughFlags(
    options.args,
    ["--command-id", "--instance-id"],
    ["--wait"],
    { service: "ssm", operation: "get-command-invocation" },
  );
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  if (doWait) {
    // Poll with a generous 10-minute default (user should use ssm run for new calls;
    // --wait on get-command-invocation is the recovery path when ssm run timed out).
    const deadlineMs = Date.now() + 10 * 60 * 1000;

    if (hasQuery) {
      // --query + --wait: poll until terminal, then apply JMESPath on the last call.
      // Simplest safe approach: poll without --query, then make a final query call.
      // We poll without passthrough (no --query) to get the raw response, then
      // issue one final call with --query to get the JMESPath result.
      await pollInvocation(commandId, instanceId, deadlineMs, options);

      // Final call with the full passthrough including --query.
      return awsJson<Record<string, unknown>>(
        [
          "ssm", "get-command-invocation",
          "--command-id", commandId,
          "--instance-id", instanceId,
          ...passthrough,
        ],
        toRunOpts(options),
      );
    }

    const invocation = await pollInvocation(commandId, instanceId, deadlineMs, options);
    return projectInvocation(invocation);
  }

  // Single call (no --wait).
  const awsArgs = [
    "ssm", "get-command-invocation",
    "--command-id", commandId,
    "--instance-id", instanceId,
    ...passthrough,
  ];

  if (hasQuery) {
    // --query bypass: return the raw JMESPath result without projection.
    return awsJson<Record<string, unknown>>(awsArgs, toRunOpts(options));
  }

  const raw = await awsJson<RawGetCommandInvocationResponse>(awsArgs, toRunOpts(options));
  return projectInvocation(raw);
}

// ─── Sub-operations ───────────────────────────────────────────────────────────

async function runGetParameter(
  options: SsmRunOptions,
): Promise<SsmGetParameterResult | Record<string, unknown>> {
  const reveal = hasFlag(options.args, "--reveal");
  const positionals = extractPositionals(options.args);
  const nameArg =
    extractFlag(options.args, "--name") ?? positionals[0];

  if (nameArg === undefined || nameArg === "") {
    throw new AxiError(
      "get-parameter requires a parameter name",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm get-parameter <name>",
        "Accepted forms: /path/to/param or --name /path/to/param",
      ],
    );
  }

  // Forward unknown flags verbatim (superset contract).
  // --reveal is an overlay alias for --with-decryption; skip it here (handled above).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--name"], ["--reveal"], { service: "ssm", operation: "get-parameter" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = ["ssm", "get-parameter", "--name", nameArg];
  if (reveal) {
    awsArgs.push("--with-decryption");
  }
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, toRunOpts(options));
  }

  const response = await awsJson<RawGetParameterResponse>(awsArgs, toRunOpts(options));

  return {
    parameter: projectParameter(response.Parameter, reveal),
    ...(reveal ? {} : { suggestion: "Pass --reveal to show the actual value" }),
  };
}

async function runGetParameters(
  options: SsmRunOptions,
): Promise<{ parameterList: SsmGetParametersResult } | Record<string, unknown>> {
  const reveal = hasFlag(options.args, "--reveal");
  const positionals = extractPositionals(options.args);

  // --names flag value (single space-separated string from CLI) or positionals
  const namesFlag = extractFlag(options.args, "--names");
  const names: string[] =
    namesFlag !== undefined
      ? namesFlag.split(/\s+/).filter((n) => n !== "")
      : positionals;

  if (names.length === 0) {
    throw new AxiError(
      "get-parameters requires at least one parameter name",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm get-parameters <name1> [name2...]",
        "Or: aws-axi ssm get-parameters --names '/p1 /p2'",
      ],
    );
  }

  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--names"], ["--reveal"], { service: "ssm", operation: "get-parameters" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = ["ssm", "get-parameters", "--names", ...names];
  if (reveal) {
    awsArgs.push("--with-decryption");
  }
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, toRunOpts(options));
  }

  const response = await awsJson<RawGetParametersResponse>(awsArgs, toRunOpts(options));
  const params = response.Parameters ?? [];
  const invalid = response.InvalidParameters ?? [];

  return {
    parameterList: {
      parameters: params.map((p) => projectParameter(p, reveal)),
      invalidParameters: [...invalid],
      count: countString(params.length, undefined),
      ...(reveal ? {} : { suggestion: "Pass --reveal to show actual values" }),
    },
  };
}

async function runGetParametersByPath(
  options: SsmRunOptions,
): Promise<{ parametersByPath: SsmGetParametersByPathResult } | Record<string, unknown>> {
  const reveal = hasFlag(options.args, "--reveal");
  const positionals = extractPositionals(options.args);
  const pathArg =
    extractFlag(options.args, "--path") ?? positionals[0];

  if (pathArg === undefined || pathArg === "") {
    throw new AxiError(
      "get-parameters-by-path requires a path prefix",
      "USAGE_ERROR",
      [
        "Usage: aws-axi ssm get-parameters-by-path <path>",
        "Example: aws-axi ssm get-parameters-by-path /my/app",
      ],
    );
  }

  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");

  // Forward unknown flags verbatim (superset contract).
  const rawPassthrough = collectPassthroughFlags(
    options.args,
    ["--path", "--max-items", "--next-token"],
    ["--reveal"],
    { service: "ssm", operation: "get-parameters-by-path" },
  );
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = [
    "ssm",
    "get-parameters-by-path",
    "--path",
    pathArg,
    "--max-items",
    String(maxItems),
  ];
  if (reveal) {
    awsArgs.push("--with-decryption");
  }
  if (nextTokenArg !== undefined) {
    awsArgs.push("--starting-token", nextTokenArg);
  }
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, toRunOpts(options));
  }

  const response = await awsJson<RawGetParametersByPathResponse>(
    awsArgs,
    toRunOpts(options),
  );
  const params = response.Parameters ?? [];
  const nextToken = response.NextToken;

  if (params.length === 0) {
    return {
      parametersByPath: {
        parameters: [],
        count: "0 total",
        message: `No parameters found under path: ${pathArg}`,
        suggestion: `List parameters with \`aws-axi ssm describe-parameters\``,
      },
    };
  }

  return {
    parametersByPath: {
      parameters: params.map((p) => projectParameter(p, reveal)),
      count: countString(params.length, nextToken),
      ...(nextToken !== undefined ? { nextToken } : {}),
      ...(reveal ? {} : { suggestion: "Pass --reveal to show actual values" }),
    },
  };
}

async function runDescribeParameters(
  options: SsmRunOptions,
): Promise<{ parametersMeta: SsmDescribeParametersResult } | Record<string, unknown>> {
  const maxItems = extractMaxItems(options.args);
  const nextTokenArg = extractFlag(options.args, "--next-token");

  // Forward unknown flags verbatim (superset contract — e.g. --filters).
  const rawPassthrough = collectPassthroughFlags(options.args, ["--max-items", "--next-token"], undefined, { service: "ssm", operation: "describe-parameters" });
  const { passthrough, hasQuery } = buildPassthrough(rawPassthrough);

  const awsArgs = ["ssm", "describe-parameters", "--max-items", String(maxItems)];
  if (nextTokenArg !== undefined) {
    awsArgs.push("--starting-token", nextTokenArg);
  }
  awsArgs.push(...passthrough);

  if (hasQuery) {
    return awsJson<Record<string, unknown>>(awsArgs, toRunOpts(options));
  }

  const response = await awsJson<RawDescribeParametersResponse>(
    awsArgs,
    toRunOpts(options),
  );
  const params = response.Parameters ?? [];
  const nextToken = response.NextToken;

  if (params.length === 0) {
    return {
      parametersMeta: {
        parameters: [],
        count: "0 total",
        message: "No SSM parameters found in this account/region",
        suggestion:
          'Create a parameter with `aws ssm put-parameter --name /my/param --value <value> --type String`',
      },
    };
  }

  // Resolve KMS aliases for unique keyIds (SecureString parameters only)
  const uniqueKeyIds = [
    ...new Set(
      params
        .map((p) => p.KeyId)
        .filter((k): k is string => k !== undefined && k !== ""),
    ),
  ];

  const resolveOpts = toResolveOpts(options);
  const resolvedEntries = await Promise.all(
    uniqueKeyIds.map(async (keyId) => {
      const resolved = await resolveKey(keyId, resolveOpts).catch(() => undefined);
      return [keyId, resolved?.alias ?? undefined] as const;
    }),
  );
  const aliasMap = new Map<string, string | undefined>(resolvedEntries);

  const projected: SsmParameterMetadata[] = params.map((p) => ({
    name: p.Name,
    type: p.Type,
    version: p.Version,
    lastModified: p.LastModifiedDate,
    arn: p.ARN,
    dataType: p.DataType,
    description: p.Description,
    tier: p.Tier,
    kmsKeyAlias:
      p.KeyId !== undefined ? (aliasMap.get(p.KeyId) ?? undefined) : undefined,
  }));

  return {
    parametersMeta: {
      parameters: projected,
      count: countString(projected.length, nextToken),
      ...(nextToken !== undefined ? { nextToken } : {}),
    },
  };
}

// ─── ssmRun ───────────────────────────────────────────────────────────────────

/**
 * Core SSM logic — testable without the CLI layer.
 *
 * Dispatches to the appropriate sub-operation based on options.subcommand.
 * Empty subcommand defaults to describe-parameters.
 */
export async function ssmRun(options: SsmRunOptions): Promise<SsmRunResult> {
  switch (options.subcommand) {
    case "run":
      return runSsmRun(options);
    case "get-command-invocation":
      return runGetCommandInvocation(options);
    case "describe-parameters":
    case "": // default
      return runDescribeParameters(options);
    case "get-parameter":
      return runGetParameter(options);
    case "get-parameters":
      return runGetParameters(options);
    case "get-parameters-by-path":
      return runGetParametersByPath(options);
    default:
      throw new AxiError(
        `Unknown ssm subcommand: ${options.subcommand}`,
        "USAGE_ERROR",
        [
          "Valid subcommands: run, get-command-invocation, get-parameter, get-parameters, get-parameters-by-path, describe-parameters",
          "Run `aws-axi ssm --help` for full usage",
        ],
      );
  }
}

// ─── ssmCommand ───────────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter.
 *
 * Parses the first arg as the subcommand (defaulting to describe-parameters
 * when absent or a flag), dispatches to ssmRun, and wraps the result under
 * a top-level `ssm` key for TOON rendering by the CLI layer.
 *
 * Remote exec exit code handling:
 *   `ssm run` and `get-command-invocation` return a SsmRunCommandResult /
 *   SsmGetCommandInvocationResult with a `remoteExitCode` field. When that
 *   code is non-zero, the remote shell command failed (but the AWS API call
 *   succeeded). We signal this by setting process.exitCode = 1 before returning
 *   the structured result — agents and `set -e` scripts see a non-zero exit
 *   while still getting full stdout/stderr in the TOON output.
 *   This is exit code 1 (REMOTE_EXEC_ERROR), intentionally distinct from
 *   254 (SERVICE_CLIENT_ERROR / AWS API failure).
 */
export async function ssmCommand(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const firstArg = args[0] ?? "";

  let subcommand: string;
  let remainingArgs: string[];

  if (firstArg === "" || firstArg.startsWith("--")) {
    subcommand = "describe-parameters";
    remainingArgs = args.filter((a) => a !== "");
  } else if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    subcommand = firstArg;
    remainingArgs = args.slice(1);
  } else {
    // Not in the overlay's hot-path — delegate to the model-driven engine.
    // The engine validates against the botocore ssm model and surfaces a clean
    // USAGE_ERROR for ops that are genuinely unknown to AWS.
    return fallThroughToEngine("ssm", firstArg, args.slice(1), context);
  }

  const result = await ssmRun({ subcommand, args: remainingArgs, context });

  // Exit code mapping for ssm run and get-command-invocation.
  //
  // Gate on status BEFORE interpreting ResponseCode:
  //   1. Delivery failures (TimedOut, Undeliverable, Cancelled…) → 254
  //      SSM never ran the shell; ResponseCode is -1 as an AWS sentinel.
  //   2. Non-terminal states (InProgress, Pending…) → exit 0
  //      The command is still running; -1 is normal. Aborting set -e loops here
  //      would be wrong — the operator is polling, not reading a final result.
  //   3. Positive ResponseCode (remote shell ran and failed) → verbatim, capped at 249.
  //      ssh / docker exec semantics: remote 7 → aws-axi 7.
  //   4. -1 sentinel in a terminal non-delivery state → 250 (safety net; rare).
  //      Success always has 0; this covers malformed/unexpected responses.
  //
  // Guard: --query bypass may return a scalar; `in` throws TypeError on non-objects.
  if (
    (subcommand === "run" || subcommand === "get-command-invocation") &&
    result !== null &&
    typeof result === "object" &&
    "remoteExitCode" in result &&
    "status" in result
  ) {
    const remoteExitCode = result["remoteExitCode"];
    const status = result["status"];

    if (typeof status === "string" && SSM_DELIVERY_FAILURE_STATES.has(status)) {
      // AWS-level delivery failure — SSM never ran the shell command.
      process.exitCode = 254;
    } else if (typeof status === "string" && SSM_NON_TERMINAL_STATES.has(status)) {
      // Command still running — exit 0 so set -e polling loops don't abort.
      // (no assignment)
    } else if (typeof remoteExitCode === "number" && remoteExitCode > 0) {
      // Remote shell ran and exited non-zero. Propagate verbatim.
      // Cap at 249 to preserve the 250–255 reserved band.
      process.exitCode = Math.min(remoteExitCode, 249);
    } else if (typeof remoteExitCode === "number" && remoteExitCode === -1) {
      // -1 in a terminal, non-delivery context (unexpected; safety net).
      process.exitCode = 250;
    }
    // remoteExitCode === 0 → success → no assignment (exit 0 default).
  }

  return { ssm: result };
}
