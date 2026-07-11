/**
 * resolve-log-group — shared primitive for resolving and enriching a CloudWatch
 * Logs log group from a bare name or full ARN.
 *
 * Reused by compute overlays (Lambda, ECS, EKS) that want to surface
 * the log group's ARN, retention policy, and stored bytes from a bare name.
 *
 * Cached per process invocation — each CLI run is a fresh process, so the
 * cache only saves redundant calls within a single command execution.
 */
import { AxiError } from "axi-sdk-js";
import { awsJson, type AwsRunOptions } from "../aws.js";
import type { AwsContext } from "../context.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface LogGroupDescriptor {
  readonly name: string;
  readonly arn: string;
  readonly storedBytes: number;
  readonly retentionDays: number | "never expire";
  readonly creationTime: number;
}

export interface ResolveLogGroupOptions {
  readonly context?: AwsContext;
  readonly binary?: string;
}

// ─── Internal AWS API shapes ──────────────────────────────────────────────────

interface AwsLogGroup {
  readonly logGroupName: string;
  readonly arn: string;
  readonly storedBytes?: number;
  readonly retentionInDays?: number;
  readonly creationTime?: number;
}

interface AwsDescribeLogGroupsResponse {
  readonly logGroups: readonly AwsLogGroup[];
  readonly nextToken?: string;
  readonly NextToken?: string;
}

// ─── In-process cache ────────────────────────────────────────────────────────

const _cache = new Map<string, LogGroupDescriptor>();

/**
 * Clear the in-process cache.
 * @internal — exposed only for test teardown between test cases.
 */
export function _clearCache(): void {
  _cache.clear();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a log group by exact name or CloudWatch Logs ARN, returning an
 * enriched descriptor with ARN, retention policy, and stored bytes.
 *
 * Prefers an exact name match; falls back to the first result when only a
 * prefix was matched (useful when the caller passes a unique prefix).
 *
 * Throws SERVICE_CLIENT_ERROR (exit 254) if no group is found.
 */
export async function resolveLogGroup(
  nameOrArn: string,
  options: ResolveLogGroupOptions = {},
): Promise<LogGroupDescriptor> {
  const name = extractLogGroupName(nameOrArn);

  const cached = _cache.get(name);
  if (cached !== undefined) return cached;

  const runOpts: AwsRunOptions = {
    binary: options.binary,
    context: options.context,
  };

  const response = await awsJson<AwsDescribeLogGroupsResponse>(
    ["logs", "describe-log-groups", "--log-group-name-prefix", name],
    runOpts,
  );

  // Prefer exact match; fall back to the first result (prefix match).
  const group =
    response.logGroups.find((g) => g.logGroupName === name) ??
    response.logGroups[0];

  if (group === undefined) {
    throw new AxiError(
      `Log group not found: ${name}`,
      "SERVICE_CLIENT_ERROR",
      [
        `Run \`aws-axi logs describe-log-groups --prefix ${name}\` to list available groups`,
      ],
    );
  }

  const descriptor: LogGroupDescriptor = {
    name: group.logGroupName,
    arn: group.arn,
    storedBytes: group.storedBytes ?? 0,
    retentionDays:
      group.retentionInDays !== undefined
        ? group.retentionInDays
        : "never expire",
    creationTime: group.creationTime ?? 0,
  };

  _cache.set(name, descriptor);
  return descriptor;
}

/**
 * Extract a bare log group name from either a bare name or a CloudWatch Logs ARN.
 *
 * ARN format: `arn:aws:logs:<region>:<account>:log-group:<name>`
 *
 * The log group name starts after the `:log-group:` segment and may itself
 * contain colons (e.g. `/aws/ecs/cluster:task`).
 */
export function extractLogGroupName(nameOrArn: string): string {
  if (nameOrArn.startsWith("arn:aws:logs:")) {
    const marker = ":log-group:";
    const idx = nameOrArn.indexOf(marker);
    if (idx !== -1) {
      return nameOrArn.slice(idx + marker.length);
    }
  }
  return nameOrArn;
}
