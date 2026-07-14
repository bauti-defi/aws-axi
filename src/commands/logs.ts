/**
 * `aws-axi logs` — CloudWatch Logs read overlay.
 *
 * Sub-commands (mirrors `aws logs` operation names):
 *   tail <group> [--since 15m] [--limit 50] [--stream <name>] [--pattern <p>]
 *   filter <group> <pattern> [--since 15m] [--limit 50]
 *   describe-log-groups [--prefix <p>] [--limit 20]
 *
 * Exported shape (per whoami.ts convention):
 *   parseSince(value, now?)           → epoch ms  (pure, exported for testing)
 *   tailRun(options)                  → TailResult
 *   filterRun(options)                → TailResult
 *   describeLogGroupsRun(options)     → LogGroupsResult
 *   _extractTailArgs(args)            → TailArgs   (@internal, for arg-parsing tests)
 *   _extractFilterArgs(args)          → FilterArgs (@internal, for arg-parsing tests)
 *   logsCommand(args, context)        → AxiCliCommand adapter
 *   LOGS_HELP                         → help string
 */
import { AxiError } from "axi-sdk-js";
import type { AwsContext } from "../context.js";
import { awsJson, type AwsRunOptions } from "../aws.js";
import { fallThroughToEngine } from "../engine.js";
import { collectPassthroughFlags, buildPassthrough } from "../overlay-args.js";

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SINCE = "15m";
const DEFAULT_EVENTS_LIMIT = 50;
const DEFAULT_GROUPS_LIMIT = 20;

// ─── Internal AWS API shapes ──────────────────────────────────────────────────

interface AwsFilterLogEventsResponse {
  readonly events: readonly AwsLogEvent[];
  /** API-level pagination token (lowercase) */
  readonly nextToken?: string;
  /** CLI-level pagination token from --max-items (uppercase) */
  readonly NextToken?: string;
}

interface AwsLogEvent {
  readonly logStreamName: string;
  readonly timestamp: number;
  readonly message: string;
  readonly ingestionTime?: number;
  readonly eventId?: string;
}

interface AwsLogGroup {
  readonly logGroupName: string;
  readonly arn: string;
  readonly storedBytes?: number;
  readonly retentionInDays?: number;
  readonly creationTime?: number;
}

interface AwsDescribeLogGroupsResponse {
  readonly logGroups: readonly AwsLogGroup[];
  /** API-level pagination token (lowercase) */
  readonly nextToken?: string;
  /** CLI-level pagination token from --max-items (uppercase) */
  readonly NextToken?: string;
}

// ─── Time parsing ─────────────────────────────────────────────────────────────

const RELATIVE_RE = /^(\d+)(m|h|d)$/;

const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a `--since` value into epoch milliseconds.
 *
 * Accepts:
 * - Relative durations: `15m`, `1h`, `2h`, `6h`, `1d`
 * - Epoch-millisecond integers: `1720692000000`
 * - Fully-qualified ISO 8601 strings with a timezone: `2026-07-11T10:00:00Z`
 *   or `2026-07-11T10:00:00+05:30`
 *
 * Explicitly rejects bare ISO datetimes without a timezone designator
 * (e.g. `2026-07-11T10:00:00`) — `Date.parse` would silently parse them as
 * local time, which is non-deterministic across runtimes.
 *
 * Throws USAGE_ERROR for anything else.
 */
export function parseSince(since: string, now = Date.now()): number {
  const match = RELATIVE_RE.exec(since);
  if (match !== null) {
    const n = parseInt(match[1] ?? "0", 10);
    const ms = UNIT_MS[match[2] ?? "m"] ?? UNIT_MS["m"] ?? 60_000;
    return now - n * ms;
  }

  // Plain integer that looks like epoch ms (> year 2001)
  const asInt = Number(since);
  if (Number.isFinite(asInt) && asInt > 1_000_000_000_000) {
    return asInt;
  }

  // Reject bare ISO datetimes without a timezone designator — local-time
  // parsing is non-deterministic and produces wrong results on agent machines
  // in different TZs.  Valid: "...Z" or "...+HH:MM".
  // Pattern: YYYY-MM-DDTHH:MM:SS with optional fractional seconds, no offset.
  const BARE_ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
  if (BARE_ISO_DT_RE.test(since)) {
    throw new AxiError(
      `Ambiguous datetime "${since}" has no timezone — append Z for UTC or +HH:MM for a fixed offset`,
      "USAGE_ERROR",
      [
        "Append Z for UTC: 2026-07-11T10:00:00Z",
        "Or add an offset: 2026-07-11T10:00:00+00:00",
        "Or use a relative duration: 15m, 1h, 2h, 1d",
      ],
    );
  }

  // Fully-qualified ISO / RFC 2822 strings (with timezone)
  const asDate = Date.parse(since);
  if (!Number.isNaN(asDate)) {
    return asDate;
  }

  throw new AxiError(
    `Cannot parse --since value: "${since}" — use relative (15m, 1h, 2h, 1d) or ISO timestamp`,
    "USAGE_ERROR",
    ["Examples: --since 15m  --since 1h  --since 2026-07-11T10:00:00Z"],
  );
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function toISO(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Pull a named flag and its value from an args array, returning the value and
 * a new array with both the flag and its value removed.
 *
 * Returns `[undefined, originalCopy]` when the flag is absent.
 */
function pullFlag(
  args: readonly string[],
  flag: string,
): [string | undefined, string[]] {
  const idx = args.indexOf(flag);
  if (idx === -1) return [undefined, [...args]];
  const value = args[idx + 1];
  const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return [value, remaining];
}

// ─── tail ─────────────────────────────────────────────────────────────────────

export interface TailRunOptions {
  readonly logGroupName: string;
  /** Relative ("15m", "1h") or ISO timestamp. Default: "15m". */
  readonly since?: string;
  /** Maximum events to return. Default: 50. */
  readonly limit?: number;
  /** Restrict to a specific log stream name. */
  readonly streamName?: string;
  /** CloudWatch Logs filter pattern (optional for tail; required for filter). */
  readonly pattern?: string;
  /** CLI pagination token from a previous response's `next` field. */
  readonly nextToken?: string;
  /**
   * Unknown flags to forward verbatim to the underlying aws invocation
   * (superset contract: overlay never restricts input, only enriches output).
   * --output is stripped; --query is kept for JMESPath passthrough.
   */
  readonly passthrough?: readonly string[];
  /**
   * When true, --query was present in the CLI args. tailRun bypasses its
   * curated projection and returns the raw aws CLI response directly.
   */
  readonly hasQuery?: boolean;
  readonly context?: AwsContext;
  readonly binary?: string;
}

export interface LogEvent {
  readonly timestamp: string;
  readonly stream: string;
  readonly message: string;
}

export interface TailResult {
  readonly logGroup: string;
  readonly window: { readonly since: string; readonly until: string };
  readonly events: readonly LogEvent[];
  /** Honest summary: "50 events (window complete)" or "50 events; more available". */
  readonly showing: string;
  /**
   * Present when more results are available.
   * Contains the continuation token and usage hint.
   */
  readonly next?: string;
}

/**
 * Fetch recent log events for a log group — the #1 agent logs primitive.
 *
 * Calls `aws logs filter-log-events` with `--max-items <limit>` to cap output.
 * Projects events to compact TOON: timestamp (ISO 8601), stream, message.
 * Surfaces the CLI pagination token when more results are available.
 */
export async function tailRun(options: TailRunOptions): Promise<TailResult | Record<string, unknown>> {
  const now = Date.now();
  const sinceStr = options.since ?? DEFAULT_SINCE;
  const sinceMs = parseSince(sinceStr, now);
  const limit = options.limit ?? DEFAULT_EVENTS_LIMIT;

  const runOpts: AwsRunOptions = {
    binary: options.binary,
    context: options.context,
  };

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active and the caller did not explicitly provide --limit. options.limit is
  // undefined when --limit was absent from argv; the default cap is the overlay's
  // own curation, not a user request. An explicit --limit is always honored.
  const awsArgs: string[] = [
    "logs",
    "filter-log-events",
    "--log-group-name",
    options.logGroupName,
    "--start-time",
    String(sinceMs),
  ];
  if (!options.hasQuery || options.limit !== undefined) {
    awsArgs.push("--max-items", String(limit));
  }

  if (options.streamName !== undefined) {
    awsArgs.push("--log-stream-names", options.streamName);
  }
  if (options.pattern !== undefined && options.pattern.length > 0) {
    awsArgs.push("--filter-pattern", options.pattern);
  }
  if (options.nextToken !== undefined) {
    awsArgs.push("--starting-token", options.nextToken);
  }
  // Superset contract: forward unknown flags verbatim.
  if (options.passthrough !== undefined && options.passthrough.length > 0) {
    awsArgs.push(...options.passthrough);
  }

  if (options.hasQuery === true) {
    // --query: aws CLI applies JMESPath; response shape is unknown — bypass projection.
    return awsJson<Record<string, unknown>>(awsArgs, runOpts);
  }

  const response = await awsJson<AwsFilterLogEventsResponse>(awsArgs, runOpts);

  const events: LogEvent[] = response.events.map((e) => ({
    timestamp: toISO(e.timestamp),
    stream: e.logStreamName,
    message: e.message.trimEnd(),
  }));

  // Prefer the CLI-level token (uppercase NextToken from --max-items) over the
  // raw API token (lowercase nextToken) — the CLI token is what --starting-token
  // expects for the next page call.
  const continuationToken = response.NextToken ?? response.nextToken;
  const hasMore = continuationToken !== undefined;

  const showing =
    events.length === 0
      ? "0 events in window"
      : hasMore
        ? `showing ${events.length} events; more available`
        : `${events.length} events (window complete)`;

  return {
    logGroup: options.logGroupName,
    window: { since: toISO(sinceMs), until: toISO(now) },
    events,
    showing,
    ...(hasMore
      ? {
          next: `use --next-token ${continuationToken} to continue, or widen the window with --since`,
        }
      : {}),
  };
}

// ─── filter ──────────────────────────────────────────────────────────────────

export interface FilterRunOptions {
  readonly logGroupName: string;
  /** CloudWatch Logs filter pattern (e.g. "ERROR", "[level=ERROR]"). */
  readonly pattern: string;
  /** Relative ("15m", "1h") or ISO timestamp. Default: "15m". */
  readonly since?: string;
  /** Maximum events to return. Default: 50. */
  readonly limit?: number;
  /** CLI pagination token from a previous response's `next` field. */
  readonly nextToken?: string;
  /**
   * Unknown flags to forward verbatim to the underlying aws invocation
   * (superset contract).
   */
  readonly passthrough?: readonly string[];
  /**
   * When true, --query was present in the CLI args. filterRun (via tailRun)
   * bypasses its curated projection and returns the raw aws CLI response.
   */
  readonly hasQuery?: boolean;
  readonly context?: AwsContext;
  readonly binary?: string;
}

/**
 * Filter log events by a CloudWatch Logs filter pattern.
 * Delegates to tailRun with the pattern forwarded.
 */
export async function filterRun(options: FilterRunOptions): Promise<TailResult | Record<string, unknown>> {
  return tailRun({
    logGroupName: options.logGroupName,
    since: options.since,
    limit: options.limit,
    pattern: options.pattern,
    nextToken: options.nextToken,
    passthrough: options.passthrough,
    hasQuery: options.hasQuery,
    context: options.context,
    binary: options.binary,
  });
}

// ─── describe-log-groups ─────────────────────────────────────────────────────

export interface DescribeLogGroupsRunOptions {
  /** Filter by log group name prefix. */
  readonly prefix?: string;
  /** Maximum groups to return. Default: 20. */
  readonly limit?: number;
  /**
   * Unknown flags to forward verbatim to the underlying aws invocation
   * (superset contract: e.g. --log-group-name-prefix, --include-linked-accounts).
   */
  readonly passthrough?: readonly string[];
  /**
   * When true, --query was present in the CLI args. describeLogGroupsRun bypasses
   * its curated projection and returns the raw aws CLI response directly.
   */
  readonly hasQuery?: boolean;
  readonly context?: AwsContext;
  readonly binary?: string;
}

export interface LogGroupSummary {
  readonly name: string;
  readonly arn: string;
  readonly storedBytes: number;
  readonly retentionDays: number | "never expire";
}

export interface LogGroupsResult {
  readonly logGroups: readonly LogGroupSummary[];
  /** Honest summary: "3 log groups" or "showing 20 groups; more available". */
  readonly count: string;
  /** Present when more results are available. */
  readonly next?: string;
}

/**
 * List CloudWatch log groups, curated to the load-bearing fields.
 *
 * Calls `aws logs describe-log-groups` with `--max-items <limit>` to cap output.
 * Projects each group to: name, arn, storedBytes, retentionDays.
 */
export async function describeLogGroupsRun(
  options: DescribeLogGroupsRunOptions,
): Promise<LogGroupsResult | Record<string, unknown>> {
  const limit = options.limit ?? DEFAULT_GROUPS_LIMIT;

  const runOpts: AwsRunOptions = {
    binary: options.binary,
    context: options.context,
  };

  // --query bypass (ADR-0002): skip the overlay's default cap when --query is
  // active and no explicit --limit was given. options.limit is undefined when
  // --limit was absent from argv. An explicit --limit is always honored.
  const awsArgs: string[] = ["logs", "describe-log-groups"];
  if (!options.hasQuery || options.limit !== undefined) {
    awsArgs.push("--max-items", String(limit));
  }

  if (options.prefix !== undefined && options.prefix.length > 0) {
    awsArgs.push("--log-group-name-prefix", options.prefix);
  }
  // Superset contract: forward unknown flags verbatim.
  if (options.passthrough !== undefined && options.passthrough.length > 0) {
    awsArgs.push(...options.passthrough);
  }

  if (options.hasQuery === true) {
    // --query: aws CLI applies JMESPath; response shape is unknown — bypass projection.
    return awsJson<Record<string, unknown>>(awsArgs, runOpts);
  }

  const response = await awsJson<AwsDescribeLogGroupsResponse>(awsArgs, runOpts);

  const groups: LogGroupSummary[] = response.logGroups.map((g) => ({
    name: g.logGroupName,
    arn: g.arn,
    storedBytes: g.storedBytes ?? 0,
    retentionDays:
      g.retentionInDays !== undefined ? g.retentionInDays : "never expire",
  }));

  const continuationToken = response.NextToken ?? response.nextToken;
  const hasMore = continuationToken !== undefined;

  const count =
    groups.length === 0
      ? "0 log groups"
      : hasMore
        ? `showing ${groups.length} groups; more available`
        : `${groups.length} log groups`;

  return {
    logGroups: groups,
    count,
    ...(hasMore
      ? { next: `use --next-token ${continuationToken} to see more groups` }
      : {}),
  };
}

// ─── CLI help ─────────────────────────────────────────────────────────────────

export const LOGS_HELP = `usage: aws-axi logs <sub-command> [args] [flags]
Read CloudWatch Logs events and log groups. Capped output with honest totals.

Any flag accepted by the underlying \`aws logs\` operation (e.g.
--log-group-name-prefix, --include-linked-accounts, --query) is forwarded
verbatim — overlays never restrict the input contract, only enrich the output.

sub-commands (enriched overlays):
  tail <log-group-name>                    Fetch recent events (default: last 15m)
  filter <log-group-name> <pattern>        Filter events by CloudWatch Logs filter pattern
  describe-log-groups                      List log groups
  (any other logs sub-command falls through to the generic engine — run \`aws logs help\` to list all)

flags (tail / filter):
  --since <duration>    Lookback window: 15m, 1h, 2h, 1d, or ISO timestamp (default: 15m)
  --limit <n>           Max events to return (default: 50)
  --stream <name>       Restrict to a specific log stream (tail only)
  --pattern <p>         CloudWatch Logs filter pattern (tail only; filter takes it positionally)
  --next-token <tok>    Resume from a previous --next-token value
  --query <expr>        JMESPath; bypasses overlay projection, returns raw result
  --output              stripped (aws-axi always uses --output json internally)

flags (describe-log-groups):
  --prefix <name>       Filter by log group name prefix
  --limit <n>           Max groups to return (default: 20)

global flags:
  --profile <name>      AWS profile
  --region <region>     AWS region

examples:
  aws-axi logs tail /aws/lambda/my-function
  aws-axi logs tail /aws/lambda/my-function --since 1h --limit 100
  aws-axi logs filter /aws/lambda/my-function "ERROR" --since 2h
  aws-axi logs describe-log-groups --prefix /aws/lambda
  aws-axi logs describe-log-groups --log-group-name-prefix /aws/lambda  # forwarded verbatim
  aws-axi logs describe-log-groups --prefix /aws --limit 5 --profile prod
`;

// ─── CLI adapter ──────────────────────────────────────────────────────────────

/**
 * AxiCliCommand adapter for `aws-axi logs <sub-command> [args]`.
 *
 * Dispatches to tailRun / filterRun / describeLogGroupsRun based on the first
 * positional argument. Flags `--profile`/`--region` are already stripped by
 * the `withContextStrip` wrapper in cli.ts; this handler sees only logs-specific
 * args.
 */
export async function logsCommand(
  args: string[],
  context: AwsContext | undefined,
): Promise<Record<string, unknown>> {
  const subCommand = args[0];

  if (subCommand === undefined || subCommand.startsWith("-")) {
    throw new AxiError(
      "logs requires a sub-command: tail, filter, or describe-log-groups",
      "USAGE_ERROR",
      ["Run `aws-axi logs --help` to see available sub-commands and flags"],
    );
  }

  const rest = args.slice(1);

  // When --query is present the *Run helper already returns the raw JMESPath
  // result (shape unknown). Wrapping it in buildTailRecord / buildGroupsRecord
  // would re-project all fields to null. Detect --query here at the adapter
  // layer and bypass the record builders entirely.
  const hasQuery = args.some((a) => a === "--query" || a.startsWith("--query="));

  if (subCommand === "tail") {
    const raw = await parseTailArgs(rest, context);
    return hasQuery ? (raw as Record<string, unknown>) : buildTailRecord(raw as TailResult);
  }

  if (subCommand === "filter") {
    const raw = await parseFilterArgs(rest, context);
    return hasQuery ? (raw as Record<string, unknown>) : buildTailRecord(raw as TailResult);
  }

  if (subCommand === "describe-log-groups") {
    const raw = await parseDescribeLogGroupsArgs(rest, context);
    return hasQuery ? (raw as Record<string, unknown>) : buildGroupsRecord(raw as LogGroupsResult);
  }

  // Not in the overlay's hot-path — delegate to the model-driven engine.
  // The engine validates against the botocore logs model and surfaces a clean
  // USAGE_ERROR for ops that are genuinely unknown to AWS.
  return fallThroughToEngine("logs", subCommand, args.slice(1), context);
}

// ─── Exported arg-parsing helpers (@internal) ─────────────────────────────────
//
// These extract typed options from raw CLI args. Exported so tests can verify
// position-independent parsing (flag-before-positional) without going through
// the full subprocess boundary.

export interface TailArgs {
  readonly logGroupName: string;
  readonly since: string | undefined;
  readonly limit: number | undefined;
  readonly streamName: string | undefined;
  readonly pattern: string | undefined;
  readonly nextToken: string | undefined;
}

/**
 * Parse `logs tail` argv into typed options.
 *
 * Flags are consumed FIRST so their values are never mistaken for the positional
 * log group name. This means `--since 1h /aws/lambda/fn` resolves correctly to
 * `{logGroupName: "/aws/lambda/fn", since: "1h"}` — not `{logGroupName: "1h"}`.
 *
 * @internal — exported for arg-parsing unit tests.
 */
export function _extractTailArgs(args: readonly string[]): TailArgs {
  // Pull ALL named flags first.
  const [since, r1] = pullFlag([...args], "--since");
  const [limitStr, r2] = pullFlag(r1, "--limit");
  const [stream, r3] = pullFlag(r2, "--stream");
  const [pattern, r4] = pullFlag(r3, "--pattern");
  const [nextToken, r5] = pullFlag(r4, "--next-token");

  // First remaining non-flag string is the log group name.
  const logGroupName = r5.find((a) => !a.startsWith("-"));
  if (logGroupName === undefined) {
    throw new AxiError("logs tail requires a log group name", "USAGE_ERROR", [
      "Usage: aws-axi logs tail <log-group-name> [--since 15m] [--limit 50]",
    ]);
  }

  return {
    logGroupName,
    since,
    limit: parseLimit(limitStr),
    streamName: stream,
    pattern,
    nextToken,
  };
}

export interface FilterArgs {
  readonly logGroupName: string;
  readonly pattern: string;
  readonly since: string | undefined;
  readonly limit: number | undefined;
  readonly nextToken: string | undefined;
}

/**
 * Parse `logs filter` argv into typed options.
 *
 * Flags are consumed FIRST (same fix as `_extractTailArgs`), then the first
 * two remaining non-flag positionals are taken as `<log-group-name>` and
 * `<pattern>`.
 *
 * @internal — exported for arg-parsing unit tests.
 */
export function _extractFilterArgs(args: readonly string[]): FilterArgs {
  // Pull ALL named flags first.
  const [since, r1] = pullFlag([...args], "--since");
  const [limitStr, r2] = pullFlag(r1, "--limit");
  const [nextToken, r3] = pullFlag(r2, "--next-token");

  // Remaining non-flag positionals: [<log-group-name>, <pattern>]
  const positionals = r3.filter((a) => !a.startsWith("-"));
  const logGroupName = positionals[0];
  const pattern = positionals[1];

  if (logGroupName === undefined) {
    throw new AxiError("logs filter requires a log group name", "USAGE_ERROR", [
      "Usage: aws-axi logs filter <log-group-name> <pattern> [--since 15m]",
    ]);
  }
  if (pattern === undefined) {
    throw new AxiError("logs filter requires a filter pattern", "USAGE_ERROR", [
      "Usage: aws-axi logs filter <log-group-name> <pattern> [--since 15m]",
      'Example: aws-axi logs filter /aws/lambda/fn "ERROR"',
    ]);
  }

  return {
    logGroupName,
    pattern,
    since,
    limit: parseLimit(limitStr),
    nextToken,
  };
}

// ─── Sub-command arg parsers (private — thin callers of the exported helpers) ─

async function parseTailArgs(
  args: string[],
  context: AwsContext | undefined,
): Promise<TailResult | Record<string, unknown>> {
  const { logGroupName, since, limit, streamName, pattern, nextToken } =
    _extractTailArgs(args);
  const passthrough = collectPassthroughFlags(
    args,
    ["--since", "--limit", "--stream", "--pattern", "--next-token"],
    undefined,
    { service: "logs", operation: "filter-log-events" },
  );
  const { passthrough: fwd, hasQuery } = buildPassthrough(passthrough);
  return tailRun({ logGroupName, since, limit, streamName, pattern, nextToken, passthrough: fwd, hasQuery, context });
}

async function parseFilterArgs(
  args: string[],
  context: AwsContext | undefined,
): Promise<TailResult | Record<string, unknown>> {
  const { logGroupName, pattern, since, limit, nextToken } =
    _extractFilterArgs(args);
  const passthrough = collectPassthroughFlags(
    args,
    ["--since", "--limit", "--next-token"],
    undefined,
    { service: "logs", operation: "filter-log-events" },
  );
  const { passthrough: fwd, hasQuery } = buildPassthrough(passthrough);
  return filterRun({ logGroupName, pattern, since, limit, nextToken, passthrough: fwd, hasQuery, context });
}

async function parseDescribeLogGroupsArgs(
  args: string[],
  context: AwsContext | undefined,
): Promise<LogGroupsResult | Record<string, unknown>> {
  const [prefix, r1] = pullFlag([...args], "--prefix");
  const [limitStr] = pullFlag(r1, "--limit");
  const passthrough = collectPassthroughFlags(args, ["--prefix", "--limit"], undefined, { service: "logs", operation: "describe-log-groups" });
  const { passthrough: fwd, hasQuery } = buildPassthrough(passthrough);
  return describeLogGroupsRun({ prefix, limit: parseLimit(limitStr), passthrough: fwd, hasQuery, context });
}

// ─── Record builders (widen typed results to Record<string, unknown>) ─────────

function buildTailRecord(result: TailResult): Record<string, unknown> {
  return {
    logGroup: result.logGroup,
    window: result.window,
    events: result.events,
    showing: result.showing,
    ...(result.next !== undefined ? { next: result.next } : {}),
  };
}

function buildGroupsRecord(result: LogGroupsResult): Record<string, unknown> {
  return {
    logGroups: result.logGroups,
    count: result.count,
    ...(result.next !== undefined ? { next: result.next } : {}),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseLimit(limitStr: string | undefined): number | undefined {
  if (limitStr === undefined) return undefined;
  const n = parseInt(limitStr, 10);
  if (isNaN(n) || n < 1) {
    throw new AxiError(
      `Invalid --limit value: "${limitStr}" — must be a positive integer`,
      "USAGE_ERROR",
    );
  }
  return n;
}
