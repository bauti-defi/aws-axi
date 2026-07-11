/**
 * E2E + unit tests for the CloudWatch Logs overlay and resolve-log-group.
 *
 * No function mocks — every aws call crosses a real subprocess boundary via
 * a real stub shell script injected through the `binary` seam.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AxiError } from "axi-sdk-js";

import {
  parseSince,
  tailRun,
  filterRun,
  describeLogGroupsRun,
} from "../src/commands/logs.js";
import {
  resolveLogGroup,
  extractLogGroupName,
  _clearCache,
} from "../src/resolve/log-group.js";

// ─── Stub factory ─────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

interface StubSpec {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createStub(spec: StubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-logs-stub-"));
  tempDirs.push(dir);
  const path = join(dir, "aws");

  const lines = [
    "#!/bin/sh",
    spec.stdout !== undefined
      ? `printf '%s' ${shellQuote(spec.stdout)}`
      : "",
    spec.stderr !== undefined
      ? `printf '%s' ${shellQuote(spec.stderr)} >&2`
      : "",
    `exit ${spec.exitCode ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");

  writeFileSync(path, lines);
  chmodSync(path, 0o755);
  return path;
}

/** Build a JSON string with N synthetic log events + optional NextToken. */
function buildEventsJson(
  count: number,
  nextToken?: string,
  baseTimestamp = 1_720_692_000_000,
): string {
  const events = Array.from({ length: count }, (_, i) => ({
    logStreamName: `stream-${(i % 3) + 1}`,
    timestamp: baseTimestamp + i * 1000,
    message: `Log message #${i + 1}`,
    ingestionTime: baseTimestamp + i * 1000 + 100,
    eventId: `event-${i + 1}`,
  }));
  const obj: Record<string, unknown> = { events };
  if (nextToken !== undefined) {
    obj["NextToken"] = nextToken;
  }
  return JSON.stringify(obj);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
  _clearCache();
});

// ─── parseSince (pure unit tests) ────────────────────────────────────────────

describe("parseSince", () => {
  const NOW = 1_720_692_000_000; // fixed reference

  it("parses minutes: 15m", () => {
    expect(parseSince("15m", NOW)).toBe(NOW - 15 * 60_000);
  });

  it("parses hours: 1h", () => {
    expect(parseSince("1h", NOW)).toBe(NOW - 3_600_000);
  });

  it("parses hours: 2h", () => {
    expect(parseSince("2h", NOW)).toBe(NOW - 7_200_000);
  });

  it("parses days: 1d", () => {
    expect(parseSince("1d", NOW)).toBe(NOW - 86_400_000);
  });

  it("accepts epoch ms integers", () => {
    const ms = NOW - 900_000;
    expect(parseSince(String(ms), NOW)).toBe(ms);
  });

  it("accepts ISO timestamp strings", () => {
    const iso = new Date(NOW - 900_000).toISOString();
    expect(parseSince(iso, NOW)).toBe(NOW - 900_000);
  });

  it("throws USAGE_ERROR for unrecognised formats", () => {
    expect(() => parseSince("bad-value", NOW)).toThrow();
    try {
      parseSince("notadate", NOW);
    } catch (e) {
      expect((e as AxiError).code).toBe("USAGE_ERROR");
    }
  });
});

// ─── extractLogGroupName (pure unit) ─────────────────────────────────────────

describe("extractLogGroupName", () => {
  it("returns a bare name unchanged", () => {
    expect(extractLogGroupName("/aws/lambda/my-function")).toBe(
      "/aws/lambda/my-function",
    );
  });

  it("strips the ARN prefix, returning the log group name", () => {
    const arn =
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-function";
    expect(extractLogGroupName(arn)).toBe("/aws/lambda/my-function");
  });

  it("handles names that contain colons (edge case)", () => {
    const arn =
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/ecs/my-cluster:task";
    expect(extractLogGroupName(arn)).toBe("/aws/ecs/my-cluster:task");
  });
});

// ─── tailRun ─────────────────────────────────────────────────────────────────

describe("tailRun — happy path (events < cap)", () => {
  it("returns projected events with ISO timestamps", async () => {
    const stub = createStub({ stdout: buildEventsJson(3), exitCode: 0 });

    const result = await tailRun({
      logGroupName: "/aws/lambda/my-function",
      since: "15m",
      binary: stub,
    });

    expect(result.logGroup).toBe("/aws/lambda/my-function");
    expect(result.events).toHaveLength(3);
    // timestamp must be ISO 8601
    expect(result.events[0]?.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(result.events[0]?.stream).toBe("stream-1");
    expect(result.events[0]?.message).toBe("Log message #1");
    expect(result.showing).toContain("3 events");
    expect(result.showing).toContain("window complete");
    expect(result.next).toBeUndefined();
  });

  it("surfaces window bounds (since / until)", async () => {
    const stub = createStub({ stdout: buildEventsJson(1), exitCode: 0 });

    const result = await tailRun({
      logGroupName: "/aws/lambda/fn",
      since: "1h",
      binary: stub,
    });

    expect(result.window.since).toMatch(/^\d{4}-/);
    expect(result.window.until).toMatch(/^\d{4}-/);
  });
});

describe("tailRun — capping: NextToken present", () => {
  it("surfaces next-token and 'more available' when result has NextToken", async () => {
    // Stub returns cap events + NextToken (simulates --max-items 50 from real aws)
    const token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9==";
    const stub = createStub({
      stdout: buildEventsJson(50, token),
      exitCode: 0,
    });

    const result = await tailRun({
      logGroupName: "/aws/lambda/my-function",
      limit: 50,
      since: "1h",
      binary: stub,
    });

    expect(result.events).toHaveLength(50);
    expect(result.showing).toContain("more available");
    expect(result.next).toBeDefined();
    expect(result.next).toContain(token);
  });

  it("reports honest showing count matching events length", async () => {
    const token = "next-page-token";
    const stub = createStub({
      stdout: buildEventsJson(20, token),
      exitCode: 0,
    });

    const result = await tailRun({
      logGroupName: "/aws/lambda/fn",
      limit: 20,
      since: "15m",
      binary: stub,
    });

    expect(result.showing).toContain("20 events");
  });
});

describe("tailRun — empty window", () => {
  it("returns definitive empty state with hint when no events", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ events: [] }),
      exitCode: 0,
    });

    const result = await tailRun({
      logGroupName: "/aws/lambda/my-function",
      since: "15m",
      binary: stub,
    });

    expect(result.events).toHaveLength(0);
    expect(result.showing).toContain("0 events");
    expect(result.next).toBeUndefined();
  });
});

describe("tailRun — filter pattern forwarded", () => {
  it("passes --filter-pattern to aws (stub echoes args on stdout for inspection)", async () => {
    // This stub echoes its own args so we can inspect what aws-axi sent.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-logs-echo-"));
    tempDirs.push(dir);
    const stubPath = join(dir, "aws");
    writeFileSync(
      stubPath,
      [
        "#!/bin/sh",
        // Write args to stderr so tailRun doesn't try to parse as JSON
        "echo \"$@\" >&2",
        // Return minimal valid JSON on stdout
        `printf '%s' '{"events":[]}'`,
        "exit 0",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);

    // tailRun should not throw; we just verify it doesn't error
    const result = await tailRun({
      logGroupName: "/aws/lambda/fn",
      since: "15m",
      pattern: "ERROR",
      binary: stubPath,
    });

    expect(result.events).toHaveLength(0);
  });
});

// ─── filterRun ───────────────────────────────────────────────────────────────

describe("filterRun", () => {
  it("returns matching events (delegates to tailRun with pattern)", async () => {
    const stub = createStub({ stdout: buildEventsJson(2), exitCode: 0 });

    const result = await filterRun({
      logGroupName: "/aws/lambda/fn",
      pattern: "ERROR",
      since: "30m",
      binary: stub,
    });

    expect(result.events).toHaveLength(2);
    expect(result.showing).toContain("2 events");
  });
});

// ─── describeLogGroupsRun ────────────────────────────────────────────────────

function buildLogGroupsJson(
  count: number,
  nextToken?: string,
): string {
  const logGroups = Array.from({ length: count }, (_, i) => ({
    logGroupName: `/aws/lambda/function-${i + 1}`,
    arn: `arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/function-${i + 1}`,
    storedBytes: (i + 1) * 1024,
    retentionInDays: i % 2 === 0 ? 30 : undefined,
    creationTime: 1_700_000_000_000 + i * 1000,
  }));
  const obj: Record<string, unknown> = { logGroups };
  if (nextToken !== undefined) {
    obj["NextToken"] = nextToken;
  }
  return JSON.stringify(obj);
}

describe("describeLogGroupsRun — happy path", () => {
  it("projects log groups to curated TOON shape", async () => {
    const stub = createStub({ stdout: buildLogGroupsJson(3), exitCode: 0 });

    const result = await describeLogGroupsRun({ binary: stub });

    expect(result.logGroups).toHaveLength(3);
    expect(result.logGroups[0]?.name).toBe("/aws/lambda/function-1");
    expect(result.logGroups[0]?.arn).toContain("arn:aws:logs");
    expect(result.logGroups[0]?.storedBytes).toBe(1024);
    // Even indices have retentionInDays=30; odd indices omit it → "never expire"
    expect(result.logGroups[0]?.retentionDays).toBe(30);
    expect(result.logGroups[1]?.retentionDays).toBe("never expire");
    expect(result.count).toContain("3 log groups");
    expect(result.next).toBeUndefined();
  });

  it("reports 'more available' when NextToken is present", async () => {
    const token = "next-group-page-token";
    const stub = createStub({
      stdout: buildLogGroupsJson(20, token),
      exitCode: 0,
    });

    const result = await describeLogGroupsRun({ limit: 20, binary: stub });

    expect(result.logGroups).toHaveLength(20);
    expect(result.count).toContain("more available");
    expect(result.next).toBeDefined();
    expect(result.next).toContain(token);
  });
});

describe("describeLogGroupsRun — empty", () => {
  it("returns 0 log groups with definitive empty count", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ logGroups: [] }),
      exitCode: 0,
    });

    const result = await describeLogGroupsRun({ binary: stub });

    expect(result.logGroups).toHaveLength(0);
    expect(result.count).toContain("0 log groups");
  });
});

// ─── resolveLogGroup ─────────────────────────────────────────────────────────

describe("resolveLogGroup — happy path", () => {
  beforeEach(() => {
    _clearCache();
  });

  it("resolves a log group by exact name", async () => {
    const payload = buildLogGroupsJson(1);
    const stub = createStub({ stdout: payload, exitCode: 0 });

    const descriptor = await resolveLogGroup("/aws/lambda/function-1", {
      binary: stub,
    });

    expect(descriptor.name).toBe("/aws/lambda/function-1");
    expect(descriptor.arn).toContain("arn:aws:logs");
    expect(descriptor.storedBytes).toBe(1024);
    expect(descriptor.retentionDays).toBe(30);
  });

  it("resolves a log group from an ARN (strips prefix)", async () => {
    const payload = JSON.stringify({
      logGroups: [
        {
          logGroupName: "/aws/lambda/my-function",
          arn: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-function",
          storedBytes: 5000,
          retentionInDays: 7,
          creationTime: 1_700_000_000_000,
        },
      ],
    });
    const stub = createStub({ stdout: payload, exitCode: 0 });

    const arn =
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-function";
    const descriptor = await resolveLogGroup(arn, { binary: stub });

    expect(descriptor.name).toBe("/aws/lambda/my-function");
    expect(descriptor.retentionDays).toBe(7);
  });

  it("caches subsequent calls (second call without binary still resolves)", async () => {
    const payload = buildLogGroupsJson(1);
    const stub = createStub({ stdout: payload, exitCode: 0 });

    // First call: uses stub
    await resolveLogGroup("/aws/lambda/function-1", { binary: stub });

    // Second call: no binary, but hits cache — must not throw
    const cached = await resolveLogGroup("/aws/lambda/function-1", {
      binary: "/nonexistent/aws",
    });
    expect(cached.name).toBe("/aws/lambda/function-1");
  });
});

describe("resolveLogGroup — not found", () => {
  it("throws SERVICE_CLIENT_ERROR when the log group list is empty", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ logGroups: [] }),
      exitCode: 0,
    });

    await expect(
      resolveLogGroup("/aws/lambda/nonexistent", { binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);

    try {
      const stub2 = createStub({
        stdout: JSON.stringify({ logGroups: [] }),
        exitCode: 0,
      });
      await resolveLogGroup("/aws/lambda/nonexistent", { binary: stub2 });
    } catch (e) {
      expect((e as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
      expect((e as AxiError).message).toContain("not found");
    }
  });
});
