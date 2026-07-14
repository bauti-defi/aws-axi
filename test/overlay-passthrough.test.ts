/**
 * TDD tests for the overlay passthrough contract (issue #33).
 *
 * Invariant: an enriched overlay's INPUT contract must be a SUPERSET of the real
 * aws CLI's. The overlay changes the OUTPUT, never restricts the INPUT.
 *
 * Covers:
 *   1. ec2 describe-instances --filters → child aws receives --filters; output is
 *      still the enriched/projected shape (not raw)
 *   2. --filters with --flag=value (equals) form
 *   3. Silent-drop regression for two non-EC2 overlays (iam list-roles, logs describe-log-groups)
 *   4. --query present → raw result returned, no crash, projection bypassed
 *   5. --output json supplied by user → not duplicated in child argv
 *   6. Positional-taking overlays still parse positionals correctly when passthrough
 *      flags are also present (logs filter + kms describe-key)
 *
 * Uses the same real-exec-stub pattern as the existing test suite — no function
 * mocks, only real shell scripts injected via the binary seam or PATH.
 *
 * buildPassthrough is also tested as a pure unit.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPassthrough } from "../src/overlay-args.js";
import { ec2Run } from "../src/commands/ec2.js";
import { iamRun } from "../src/commands/iam.js";
import { describeLogGroupsRun, filterRun } from "../src/commands/logs.js";
import { kmsRun } from "../src/commands/kms.js";
import { ssmRun } from "../src/commands/ssm.js";
import { main } from "../src/cli.js";

// ── Stub factory ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Create a simple stub that always emits the given stdout and exits. */
function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-pt-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const lines = [
    "#!/bin/sh",
    spec.stdout !== undefined ? `printf '%s' ${shellQuote(spec.stdout)}` : "",
    spec.stderr !== undefined ? `printf '%s' ${shellQuote(spec.stderr)} >&2` : "",
    `exit ${spec.exitCode ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(p, lines);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Create a stub that succeeds ONLY when `requiredArg` is present in its argv.
 * If the arg is absent, the stub exits 1 with a diagnostic — proving the arg
 * was NOT forwarded if the test unexpectedly errors.
 */
function createArgGuardStub(spec: {
  requiredArg: string;
  validStdout: string;
  fallbackStdout?: string; // when requiredArg is absent but we should NOT fail (e.g. secondary calls)
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-argguard-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const script = [
    "#!/bin/sh",
    "found=0",
    "for arg in \"$@\"; do",
    `  [ "$arg" = ${shellQuote(spec.requiredArg)} ] && found=1`,
    "done",
    'if [ "$found" = "1" ]; then',
    `  printf '%s' ${shellQuote(spec.validStdout)}`,
    "else",
    spec.fallbackStdout !== undefined
      ? `  printf '%s' ${shellQuote(spec.fallbackStdout)}`
      : `  printf '%s' ${shellQuote(`MISSING_FLAG: ${spec.requiredArg} was not forwarded`)} >&2 && exit 1`,
    "fi",
  ].join("\n");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Stub that fails when --output appears more than once in argv.
 * The exec seam always appends --output json; user-supplied --output must be
 * stripped from passthrough before forwarding to avoid duplication.
 */
function createDedupGuardStub(spec: { validStdout: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-dedup-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const script = [
    "#!/bin/sh",
    "count=0",
    "for arg in \"$@\"; do",
    '  [ "$arg" = "--output" ] && count=$((count + 1))',
    "done",
    'if [ "$count" -gt 1 ]; then',
    "  printf 'DUPLICATE_OUTPUT: --output appeared %d times' \"$count\" >&2",
    "  exit 1",
    "fi",
    `printf '%s' ${shellQuote(spec.validStdout)}`,
  ].join("\n");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── captureMain helper (same pattern as overlay-fallthrough.test.ts) ─────────

async function captureMain(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const stdout = {
    write(chunk: string): true {
      chunks.push(chunk);
      return true;
    },
  };

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  const prevExitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  try {
    await main({ argv, stdout });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  const rawExitCode = process.exitCode as number;
  const exitCode: number | undefined = rawExitCode === 0 ? undefined : rawExitCode;
  process.exitCode = prevExitCode;

  return { output: chunks.join(""), exitCode };
}

/** Extract the directory containing the stub `aws` binary (for PATH injection). */
function stubDir(binary: string): string {
  return binary.replace(/\/aws$/, "");
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Minimal EC2 instance: no SG / subnet / IAM profile so no secondary resolver calls.
const ONE_INSTANCE = JSON.stringify({
  Reservations: [
    {
      ReservationId: "r-0001",
      OwnerId: "123456789012",
      Instances: [
        {
          InstanceId: "i-0abc123def456",
          InstanceType: "t3.micro",
          State: { Code: 16, Name: "running" },
          Placement: { AvailabilityZone: "us-east-1a" },
          SecurityGroups: [],
          Tags: [{ Key: "Name", Value: "pt-test-instance" }],
        },
      ],
    },
  ],
});

const EMPTY_INSTANCES = JSON.stringify({ Reservations: [] });

// ── Unit tests for buildPassthrough ──────────────────────────────────────────

describe("buildPassthrough — unit", () => {
  it("strips --output <value> (two-arg form) from passthrough", () => {
    const { passthrough } = buildPassthrough([
      "--filters",
      "Name=tag:Env,Values=prod",
      "--output",
      "json",
    ]);
    expect(passthrough).not.toContain("--output");
    expect(passthrough).not.toContain("json");
    expect(passthrough).toEqual(["--filters", "Name=tag:Env,Values=prod"]);
  });

  it("strips --output=value (equals form) from passthrough", () => {
    const { passthrough } = buildPassthrough([
      "--filters",
      "Name=...",
      "--output=table",
    ]);
    expect(passthrough).not.toContain("--output=table");
    expect(passthrough).toEqual(["--filters", "Name=..."]);
  });

  it("detects --query and sets hasQuery=true while keeping it in passthrough", () => {
    const { passthrough, hasQuery } = buildPassthrough([
      "--filters",
      "Name=...",
      "--query",
      "Reservations[].Instances[]",
    ]);
    expect(hasQuery).toBe(true);
    // --query must remain in passthrough so the aws CLI applies JMESPath
    expect(passthrough).toContain("--query");
    expect(passthrough).toContain("Reservations[].Instances[]");
  });

  it("detects --query=value (equals form) and sets hasQuery=true", () => {
    const { hasQuery, passthrough } = buildPassthrough([
      "--query=Reservations[].Instances[]",
    ]);
    expect(hasQuery).toBe(true);
    expect(passthrough).toContain("--query=Reservations[].Instances[]");
  });

  it("returns empty passthrough with hasQuery=false when remaining is empty", () => {
    const { passthrough, hasQuery } = buildPassthrough([]);
    expect(passthrough).toEqual([]);
    expect(hasQuery).toBe(false);
  });

  it("preserves unknown flags and their values verbatim", () => {
    const { passthrough } = buildPassthrough([
      "--filters",
      "Name=instance-state-name,Values=running",
      "--dry-run",
    ]);
    expect(passthrough).toEqual([
      "--filters",
      "Name=instance-state-name,Values=running",
      "--dry-run",
    ]);
  });
});

// ── EC2 overlay passthrough tests ─────────────────────────────────────────────

describe("ec2 overlay passthrough", () => {
  it("describe-instances --filters is forwarded to child aws AND output is enriched projection", async () => {
    // Stub succeeds ONLY when --filters is present in argv (i.e., was forwarded).
    const binary = createArgGuardStub({
      requiredArg: "--filters",
      validStdout: ONE_INSTANCE,
    });

    const result = await ec2Run({
      operation: "describe-instances",
      passthrough: ["--filters", "Name=instance-state-name,Values=running"],
      binary,
    });

    // Enriched projection: lowercase "instances" key, not raw "Reservations"
    expect(result).toHaveProperty("instances");
    expect(result).toHaveProperty("count", 1);
    expect((result["instances"] as unknown[])[0]).toMatchObject({
      id: "i-0abc123def456",
      name: "pt-test-instance",
      state: "running",
    });
    expect(result).not.toHaveProperty("Reservations");
  });

  it("describe-instances --filters=value (equals form) is forwarded to child aws", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--filters=Name=instance-state-name,Values=running",
      validStdout: ONE_INSTANCE,
    });

    const result = await ec2Run({
      operation: "describe-instances",
      passthrough: ["--filters=Name=instance-state-name,Values=running"],
      binary,
    });

    expect(result).toHaveProperty("instances");
    expect(result).toHaveProperty("count", 1);
  });

  it("describe-vpcs with passthrough flag forwarded AND output is still enriched", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--filters",
      validStdout: JSON.stringify({
        Vpcs: [
          {
            VpcId: "vpc-abc123",
            CidrBlock: "10.0.0.0/16",
            State: "available",
            IsDefault: false,
            OwnerId: "123456789012",
            Tags: [{ Key: "Name", Value: "prod-vpc" }],
          },
        ],
      }),
    });

    const result = await ec2Run({
      operation: "describe-vpcs",
      passthrough: ["--filters", "Name=state,Values=available"],
      binary,
    });

    // Enriched: lowercase "vpcs" (not raw "Vpcs")
    expect(result).toHaveProperty("vpcs");
    expect(result).not.toHaveProperty("Vpcs");
    expect((result["vpcs"] as unknown[])[0]).toMatchObject({
      id: "vpc-abc123",
      name: "prod-vpc",
    });
  });

  it("describe-instances --query bypasses overlay projection, returns raw queried result without crash", async () => {
    // When --query is used, the aws CLI applies JMESPath; overlay projection
    // would crash or mis-project. We bypass projection and return the raw result.
    const binary = createStub({
      // Stub returns what aws CLI would return with --query (a bare array)
      stdout: JSON.stringify(["i-0abc123def456", "i-0def789ghi012"]),
      exitCode: 0,
    });

    const result = await ec2Run({
      operation: "describe-instances",
      hasQuery: true,
      passthrough: ["--query", "Reservations[].Instances[].InstanceId"],
      binary,
    });

    // No crash; raw result contains the queried data
    expect(JSON.stringify(result)).toContain("i-0abc123def456");
    // Overlay projection was bypassed — no enriched "instances" / "count" keys
    expect(result).not.toHaveProperty("instances");
    expect(result).not.toHaveProperty("count");
  });

  it("--output json from user is NOT duplicated in child aws argv", async () => {
    // The exec seam always appends --output json. If user-supplied --output is
    // also in passthrough (not stripped), the child sees --output twice.
    // The dedup guard stub fails if that happens.
    const binary = createDedupGuardStub({
      validStdout: EMPTY_INSTANCES,
    });

    // passthrough contains user-supplied --output json — must be stripped before forwarding
    const result = await ec2Run({
      operation: "describe-instances",
      passthrough: ["--output", "json"],
      binary,
    });

    // Stub ran without error (no duplicate detected); overlay returned enriched shape
    expect(result).toHaveProperty("instances");
  });

  it("--output=json (equals form) from user is NOT duplicated in child aws argv", async () => {
    const binary = createDedupGuardStub({
      validStdout: EMPTY_INSTANCES,
    });

    const result = await ec2Run({
      operation: "describe-instances",
      passthrough: ["--output=json"],
      binary,
    });

    expect(result).toHaveProperty("instances");
  });
});

// ── IAM overlay passthrough — silent-drop regression ─────────────────────────

describe("iam overlay passthrough — silent-drop regression", () => {
  it("list-roles with an unknown flag (--path-prefix) forwards it to child aws", async () => {
    // --path-prefix is a real aws iam list-roles flag that the overlay doesn't know.
    // Previously it was silently dropped; now it must reach the child aws process.
    const binary = createArgGuardStub({
      requiredArg: "--path-prefix",
      validStdout: JSON.stringify({
        Roles: [
          {
            RoleName: "filtered-role",
            RoleId: "AROA000000000000001",
            Arn: "arn:aws:iam::123456789012:role/filtered-role",
            CreateDate: "2024-01-01T00:00:00Z",
          },
        ],
      }),
    });

    const result = await iamRun({
      op: "list-roles",
      args: ["--path-prefix", "/my/path"],
      binary,
    });

    // Stub succeeded (--path-prefix was forwarded) → enriched projection
    expect(result).toHaveProperty("roles");
    expect((result as { roles: unknown[] }).roles).toHaveLength(1);
  });

  it("get-role --query bypasses overlay projection, returns raw queried result", async () => {
    // --query is in the passthrough for get-role; projection is bypassed.
    const binary = createStub({
      stdout: JSON.stringify("arn:aws:iam::123456789012:role/my-role"),
      exitCode: 0,
    });

    const result = await iamRun({
      op: "get-role",
      args: ["my-role", "--query", "Role.Arn"],
      binary,
    });

    // No crash; raw JMESPath result is returned
    expect(JSON.stringify(result)).toContain("arn:aws:iam");
    // Overlay projection bypassed — no "role" key in output
    expect(result).not.toHaveProperty("role");
  });

  it("list-policies with unknown flag (--query-filter) forwards it to child aws", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--query-filter",
      validStdout: JSON.stringify({
        Policies: [],
      }),
    });

    const result = await iamRun({
      op: "list-policies",
      args: ["--query-filter", "some-value"],
      binary,
    });

    expect(result).toHaveProperty("policies");
  });
});

// ── Logs overlay passthrough — silent-drop regression ────────────────────────

describe("logs overlay passthrough — silent-drop regression", () => {
  it("describe-log-groups with unknown flag (--log-group-name-prefix) forwards it to child aws", async () => {
    // The overlay knows --prefix (which it maps to --log-group-name-prefix).
    // But if the user passes --log-group-name-prefix verbatim, it must be
    // forwarded via passthrough — not silently dropped.
    const binary = createArgGuardStub({
      requiredArg: "--log-group-name-prefix",
      validStdout: JSON.stringify({
        logGroups: [
          {
            logGroupName: "/aws/lambda/my-fn",
            arn: "arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn",
            storedBytes: 0,
          },
        ],
      }),
    });

    const result = await describeLogGroupsRun({
      passthrough: ["--log-group-name-prefix", "/aws/lambda"],
      binary,
    });
    // Stub succeeded (--log-group-name-prefix was forwarded) → enriched projection
    expect(result).toHaveProperty("logGroups");
  });

  it("filter: positionals (group + pattern) still parsed correctly when passthrough flag present", async () => {
    // The stub guards on --start-time being forwarded (unknown to the filter overlay).
    // If the overlay still extracts group+pattern correctly AND forwards --start-time,
    // the stub succeeds and we get back the expected event.
    const binary = createArgGuardStub({
      requiredArg: "--start-time",
      validStdout: JSON.stringify({
        events: [
          {
            logStreamName: "stream-1",
            timestamp: 1720692000000,
            message: "ERROR: something failed",
          },
        ],
      }),
    });

    // filterRun is the typed interface; we pass the passthrough as part of
    // the options after the fix is in place.
    const result = await filterRun({
      logGroupName: "/aws/lambda/my-fn",
      pattern: "ERROR",
      passthrough: ["--start-time", "1720692000000"],
      binary,
    });

    expect(result).toHaveProperty("events");
    expect((result.events as unknown[]).length).toBe(1);
    expect((result.events[0] as { message: string }).message).toContain("ERROR");
  });
});

// ── KMS overlay: positional + passthrough ─────────────────────────────────────

describe("kms overlay passthrough — positional + passthrough", () => {
  it("describe-key: positional key-id parsed correctly AND unknown flag forwarded", async () => {
    // describe-key takes a positional (key id / alias). Unknown flags must also be
    // forwarded to the child aws process.
    // The stub handles two calls: describe-key (guards on --grant-tokens) and
    // list-aliases (the overlay's secondary enrichment call).
    const binary = createArgGuardStub({
      requiredArg: "--grant-tokens",
      validStdout: JSON.stringify({
        KeyMetadata: {
          KeyId: "abcd-1234-efgh-5678",
          Arn: "arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678",
          Enabled: true,
          Description: "test key",
          KeyState: "Enabled",
          KeyManager: "CUSTOMER",
          KeyUsage: "ENCRYPT_DECRYPT",
          KeySpec: "SYMMETRIC_DEFAULT",
        },
      }),
      // For the secondary list-aliases call (no --grant-tokens), return empty aliases.
      fallbackStdout: JSON.stringify({ Aliases: [] }),
    });

    const result = await kmsRun({
      subcommand: "describe-key",
      args: ["alias/my-key", "--grant-tokens", "token1"],
      binary,
    });

    // Overlay projection applied: "key" in result
    const r = result as { key?: { keyId: string } };
    expect(r).toHaveProperty("key");
    expect(r.key?.keyId).toBe("abcd-1234-efgh-5678");
  });

  it("list-keys with unknown flag (--key-usage) forwarded to child aws", async () => {
    // --key-usage is a real aws kms list-keys flag the overlay doesn't know.
    const binary = createArgGuardStub({
      requiredArg: "--key-usage",
      // list-aliases secondary call also needs Aliases response
      validStdout: JSON.stringify({
        Keys: [{ KeyId: "key-1", KeyArn: "arn:aws:kms:us-east-1:123:key/key-1" }],
      }),
      fallbackStdout: JSON.stringify({ Aliases: [] }),
    });

    const result = await kmsRun({
      subcommand: "list-keys",
      args: ["--key-usage", "ENCRYPT_DECRYPT"],
      binary,
    });

    const r = result as { listKeys?: { keys: unknown[] } };
    expect(r).toHaveProperty("listKeys");
  });
});

// ── Stub: exits 1 when a required arg is absent OR a guarded arg appears > once ─

/**
 * Stub that:
 *  - Exits 1 if `requiredArg` is absent from child argv (arg was not forwarded).
 *  - Exits 1 if `argMustAppearOnce` appears more than once (positional duplicated).
 *  - Exits 0 otherwise.
 */
function createForwardAndDedupeGuardStub(spec: {
  requiredArg: string;
  argMustAppearOnce: string;
  validStdout?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-fwddedup-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const script = [
    "#!/bin/sh",
    "found=0",
    "count=0",
    'for arg in "$@"; do',
    `  [ "$arg" = ${shellQuote(spec.requiredArg)} ] && found=1`,
    `  [ "$arg" = ${shellQuote(spec.argMustAppearOnce)} ] && count=$((count + 1))`,
    "done",
    'if [ "$found" != "1" ]; then',
    `  printf 'MISSING_FLAG: %s was not forwarded\\n' ${shellQuote(spec.requiredArg)} >&2`,
    "  exit 1",
    "fi",
    'if [ "$count" -gt 1 ]; then',
    `  printf 'DUPLICATE: %s appears %d times\\n' ${shellQuote(spec.argMustAppearOnce)} "$count" >&2`,
    "  exit 1",
    "fi",
    spec.validStdout !== undefined ? `printf '%s' ${shellQuote(spec.validStdout)}` : "",
    "exit 0",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

// ── Full CLI integration via captureMain ──────────────────────────────────────

describe("ec2 overlay passthrough — full CLI integration", () => {
  it("aws-axi ec2 describe-instances --filters … end-to-end: no rejection, enriched output", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--filters",
      validStdout: ONE_INSTANCE,
    });

    const { output, exitCode } = await captureMain(
      [
        "ec2",
        "describe-instances",
        "--filters",
        "Name=instance-state-name,Values=running",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // No rejection error
    expect(output).not.toContain("USAGE_ERROR");
    expect(output).not.toContain("Unknown flag");
    expect(exitCode).toBeUndefined();
    // Enriched TOON projection
    expect(output).toContain("instances");
    expect(output).toContain("pt-test-instance");
  });
});

// ── Blocker A: --query bypass must reach the CLI adapter layer, not just *Run ─
//
// The *Run helpers (tailRun, describeLogGroupsRun, etc.) bypass projection when
// hasQuery=true, but the CLI adapter wraps their result in a record builder
// (buildTailRecord, buildGroupsRecord) AFTER the call. That second projection
// re-nulls every field. The fix must live in logsCommand / s3Command.
//
// Revert-proof: disable the `if (hasQuery)` bypass in logsCommand → these fail.

describe("logs overlay passthrough — --query bypass at CLI adapter layer", () => {
  // Fixed JSON the stub returns when --query is present: a raw array that JMESPath
  // would produce. When the adapter re-projects it as TailResult the fields are
  // all null/undefined; when it passes through correctly we see the raw value.
  const RAW_QUERY_RESULT = JSON.stringify(["error: foo", "error: bar"]);

  it("logs tail --query: bypasses projection, output is not re-projected as TailResult", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: RAW_QUERY_RESULT,
    });

    const { output, exitCode } = await captureMain(
      ["logs", "tail", "/aws/lambda/fn", "--query", "events[].message"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // Must NOT be re-projected through buildTailRecord (which yields all-null fields).
    expect(output).not.toContain("logGroup: null");
    expect(output).not.toContain("events: null");
    expect(output).not.toContain("window: null");
  });

  it("logs describe-log-groups --query: bypasses projection, not re-projected as LogGroupsResult", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(["group-a", "group-b"]),
    });

    const { output, exitCode } = await captureMain(
      ["logs", "describe-log-groups", "--query", "logGroups[].logGroupName"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("logGroups: null");
    expect(output).not.toContain("count: null");
  });
});

// ── Blocker A (s3): --query bypass — forwarded to child and projection skipped ─
//
// s3 ls (and head-object) rewrite to s3api, so the response shape changes when
// --query is active. Without a bypass, s3LsRun sees an empty Contents array and
// returns { empty: true, hint: "No objects found…" } — a false positive.
//
// Revert-proof: remove the `if (options.hasQuery)` early return in s3LsRun → fails.

describe("s3 overlay passthrough — --query bypass", () => {
  it("s3 ls s3://b/ --query: --query forwarded, no false-positive empty result", async () => {
    // The stub acts as aws s3api list-objects-v2 --query 'Contents[].Key'
    // returning an array of key strings (what JMESPath would produce).
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(["file1.txt", "file2.txt"]),
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--query", "Contents[].Key"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // Must NOT be the false-positive empty projection.
    expect(output).not.toContain("No objects found");
    // --query was forwarded (arg guard stub succeeded).
  });
});

// ── Blocker B: s3 positional ordering — heuristic must not eat positionals ────
//
// When a passthrough flag (e.g. --recursive) precedes the positional URI, the
// heuristic consumed the URI as the flag's value and then duplicated it in the
// child argv. The fix is to strip identified positionals before calling
// collectPassthroughFlags so no bare token is ever consumed as a flag value.
//
// Revert-proof: remove positional stripping from s3Command → stub exits 1 on
// duplicate URI or missing --recursive.

describe("s3 overlay passthrough — positional ordering", () => {
  it("s3 cp --recursive <src> <dst>: --recursive forwarded, source URI not duplicated", async () => {
    // Stub fails if --recursive is absent OR if s3://src/dir/ appears more than once.
    // Without the fix: passthrough = ["--recursive", "s3://src/dir/"] (heuristic ate the URI),
    // then s3CpRun adds source again → URI appears twice → stub exits 1.
    const binary = createForwardAndDedupeGuardStub({
      requiredArg: "--recursive",
      argMustAppearOnce: "s3://src/dir/",
    });

    const { output, exitCode } = await captureMain(
      ["s3", "cp", "--recursive", "s3://src/dir/", "/tmp/dir/"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("USAGE_ERROR");
  });

  it("s3 rm s3://b/prefix/ --recursive: --recursive forwarded, URI not duplicated", async () => {
    const binary = createForwardAndDedupeGuardStub({
      requiredArg: "--recursive",
      argMustAppearOnce: "s3://b/prefix/",
    });

    const { output, exitCode } = await captureMain(
      ["s3", "rm", "s3://b/prefix/", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("USAGE_ERROR");
  });

  it("s3 cp /tmp/f.txt s3://b/f.txt --sse aws:kms: both sse flags forwarded", async () => {
    // Both --sse and --sse-kms-key-id must reach the child process.
    // If positional-eating had consumed /tmp/f.txt as --sse's value, --sse-kms-key-id
    // would be absent and the stub would exit 1.
    const binary = createArgGuardStub({
      requiredArg: "--sse-kms-key-id",
      validStdout: "",
    });

    const { exitCode } = await captureMain(
      ["s3", "cp", "/tmp/f.txt", "s3://b/f.txt", "--sse", "aws:kms", "--sse-kms-key-id", "alias/k"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── SSM model-based boolean flag classification ───────────────────────────────
//
// WithDecryption and Recursive are boolean in the botocore SSM model. The
// model-based path classifies them correctly and does not eat the next positional
// as their value. Tests drive ssmRun directly via the binary seam.
//
// Revert-proof: remove the ModelContext from collectPassthroughFlags in ssm.ts
// → heuristic eats /my/param → stub exits 1 (either missing --with-decryption
// or duplicate /my/param).

describe("ssm overlay passthrough — boolean flag classification via botocore model", () => {
  it("get-parameter --with-decryption /my/param: flag forwarded, positional not eaten", async () => {
    // Without model classification: heuristic treats --with-decryption as value-taking
    // → consumes /my/param as its value → /my/param is ALSO in nameArg → duplicated
    // in awsArgs as ["ssm", "get-parameter", "--name", "/my/param", "--with-decryption", "/my/param"]
    // → real aws exits 252; our stub exits 1 for the duplicate.
    const binary = createForwardAndDedupeGuardStub({
      requiredArg: "--with-decryption",
      argMustAppearOnce: "/my/param",
      validStdout: JSON.stringify({
        Parameter: { Name: "/my/param", Type: "SecureString", Value: "secret" },
      }),
    });

    const result = await ssmRun({
      subcommand: "get-parameter",
      args: ["--with-decryption", "/my/param"],
      binary,
    });

    expect(result).toHaveProperty("parameter");
  });

  it("get-parameters-by-path --recursive /my/app: --recursive forwarded, path not eaten", async () => {
    const binary = createForwardAndDedupeGuardStub({
      requiredArg: "--recursive",
      argMustAppearOnce: "/my/app",
      validStdout: JSON.stringify({
        Parameters: [{ Name: "/my/app/key", Type: "String", Value: "val" }],
      }),
    });

    const result = await ssmRun({
      subcommand: "get-parameters-by-path",
      args: ["--recursive", "/my/app"],
      binary,
    });

    expect(result).toHaveProperty("parametersByPath");
  });
});

// ── captureMain --query bypass tests: ssm / kms / lambda / secrets / s3 head-object ─
//
// Each test drives the full CLI adapter via captureMain with --query present.
// The stub returns a pre-filtered JMESPath result (a bare string or array)
// that would NOT appear in the output if the overlay re-projected it.
//
// Revert-proof:
//   - For ssm/lambda/secrets: disable the `if (hasQuery)` block → the overlay tries
//     to map the stub's bare string as the AWS response type → `undefined` fields
//     everywhere → output lacks the marker value, test fails.
//   - For kms: same as ssm; additionally the secondary alias call degrades gracefully,
//     but the primary projection returns an empty key list, not the marker.
//   - For s3 head-object: disable the bypass → overlay maps the stub's bare string as
//     HeadObjectResponse → all fields undefined → output lacks the marker, test fails.

describe("--query bypass at captureMain level — ssm/kms/lambda/secrets/s3-head-object", () => {
  it("ssm get-parameter --query bypasses overlay projection, marker appears in output", async () => {
    const MARKER = "ssm-query-bypass-ok";
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(MARKER),
    });

    const { output, exitCode } = await captureMain(
      ["ssm", "get-parameter", "--name", "/test/param", "--query", "Parameter.Value"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Must exit cleanly and must not re-project the raw JMESPath result through
    // SSM's typed projection (which would null out all fields and lose the marker).
    expect(exitCode).toBeUndefined();
    expect(output).toContain(MARKER);
  });

  it("kms list-keys --query bypasses overlay projection, marker appears in output", async () => {
    const MARKER = "kms-key-id-bypass-ok";
    // The primary list-keys call has --query; the secondary list-aliases call (only
    // reached if the bypass is absent) does not — so we provide a fallback that
    // returns an empty Aliases list, ensuring the secondary call doesn't hard-fail.
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(MARKER),
      fallbackStdout: JSON.stringify({ Aliases: [] }),
    });

    const { output, exitCode } = await captureMain(
      ["kms", "list-keys", "--query", "Keys[0].KeyId"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // With bypass active: marker is the raw JMESPath result that flows through.
    // Without bypass: overlay projects the bare string as RawListKeysResponse,
    // gets Keys=undefined, returns the "No KMS keys found" message — not the marker.
    expect(output).toContain(MARKER);
    expect(output).not.toContain("No KMS keys found");
  });

  it("lambda list-functions --query bypasses overlay projection, marker appears in output", async () => {
    const MARKER = "lambda-fn-bypass-ok";
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(MARKER),
    });

    const { output, exitCode } = await captureMain(
      ["lambda", "list-functions", "--query", "Functions[0].FunctionName"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain(MARKER);
  });

  it("secretsmanager get-secret-value --query bypasses overlay projection, marker appears in output", async () => {
    const MARKER = "secret-bypass-ok";
    // The primary get-secret-value call has --query. Without bypass a secondary
    // describe-secret call would fire (no --query, so stub exits 1), but that
    // secondary call is .catch'd, so only the projection failure exposes bypass absence.
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(MARKER),
    });

    const { output, exitCode } = await captureMain(
      ["secretsmanager", "get-secret-value", "--secret-id", "my-secret", "--query", "SecretString"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // Without bypass: overlay maps the bare string as RawGetSecretValueResponse,
    // SecretString is undefined → secretValue is REDACTED (not the marker).
    expect(output).toContain(MARKER);
  });

  it("s3 head-object --query bypasses overlay projection, marker appears in output", async () => {
    const MARKER = "s3-head-bypass-ok";
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(MARKER),
    });

    const { output, exitCode } = await captureMain(
      ["s3", "head-object", "--bucket", "my-bucket", "--key", "my/key.txt", "--query", "ContentType"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // Without bypass: overlay maps the bare string as HeadObjectResponse,
    // ContentType is undefined → contentType is null in output, not the marker.
    expect(output).toContain(MARKER);
  });
});

// ── s3 ls flag translation — issue #38 ───────────────────────────────────────
//
// s3 ls rewrites to s3api list-objects-v2. Before the fix, aws s3-level flags
// (--recursive, --human-readable, --summarize) were forwarded verbatim into the
// s3api child, which rejected them with an opaque exit 252.
//
// The fix:
//   - --recursive: absorbed as an overlay-owned boolean (list-objects-v2 already
//     returns all objects; no delimiter = recursive by default). NOT forwarded.
//   - --human-readable: intercepted with a clean USAGE_ERROR.
//   - --summarize: intercepted with a clean USAGE_ERROR.
//   - --page-size: valid s3api flag; forwarded verbatim (already works, verified
//     still works after the fix so we don't regress).
//
// Revert-proof: revert the fix (remove --recursive from ownedBoolFlags, remove
// --human-readable / --summarize USAGE_ERROR guards) → tests below go RED.

/**
 * Stub that FAILS (exits 1) if `rejectedArg` appears anywhere in its argv.
 * Exits 0 with validStdout otherwise.
 */
function createRejectArgStub(spec: {
  rejectedArg: string;
  validStdout: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-reject-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const script = [
    "#!/bin/sh",
    "for arg in \"$@\"; do",
    `  if [ "$arg" = ${shellQuote(spec.rejectedArg)} ]; then`,
    `    printf 'REJECTED: %s must NOT be forwarded to s3api\\n' ${shellQuote(spec.rejectedArg)} >&2`,
    "    exit 252",
    "  fi",
    "done",
    `printf '%s' ${shellQuote(spec.validStdout)}`,
    "exit 0",
  ].join("\n");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

/** Minimal list-objects-v2 response with one object. */
const ONE_OBJECT_RESPONSE = JSON.stringify({
  Contents: [
    {
      Key: "file.txt",
      Size: 1024,
      LastModified: "2024-01-01T00:00:00+00:00",
      ETag: '"abc"',
      StorageClass: "STANDARD",
    },
  ],
  KeyCount: 1,
  MaxKeys: 20,
  IsTruncated: false,
  Name: "bucket",
  Prefix: "",
});

describe("s3 ls flag translation — #38", () => {
  // ── --recursive: must be absorbed, never forwarded to s3api ──────────────
  //
  // Revert-proof: remove ["--recursive"] from ownedBoolFlags in the "ls" case
  // of s3Command → --recursive reaches the stub → stub exits 252 → test fails.

  it("s3 ls s3://b/ --recursive: --recursive is NOT forwarded to s3api child", async () => {
    // Stub exits 252 if --recursive appears anywhere in its argv.
    // Before fix: collectPassthroughFlags includes --recursive in passthrough
    //             → forwarded → stub exits 252 → test fails.
    // After fix:  --recursive is an owned bool flag, stripped before passthrough
    //             → stub exits 0 → test passes.
    const binary = createRejectArgStub({
      rejectedArg: "--recursive",
      validStdout: ONE_OBJECT_RESPONSE,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("REJECTED");
    expect(output).not.toContain("USAGE_ERROR");
    // Overlay still returns enriched output
    expect(output).toContain("objects");
  });

  it("s3 ls s3://b/ --recursive: returns enriched object listing (no spurious empty)", async () => {
    // Regression guard: --recursive must not consume the s3:// URI as its value
    // (positional-stripping prevents this). Also confirms the overlay projection
    // still runs and produces the curated shape.
    const binary = createStub({
      stdout: ONE_OBJECT_RESPONSE,
      exitCode: 0,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("No objects found");
    expect(output).toContain("file.txt");
  });

  // ── --human-readable: USAGE_ERROR (display-only flag, no s3api equivalent) ─
  //
  // Revert-proof: remove the --human-readable USAGE_ERROR guard in s3Command →
  // --human-readable is forwarded to s3api list-objects-v2 → s3api exits 252
  // with an opaque "Unknown options: --human-readable" → test expects a clean
  // USAGE_ERROR from the overlay, not an opaque error from the child.

  it("s3 ls --human-readable: overlay emits clean USAGE_ERROR (not an opaque s3api error)", async () => {
    // The stub should never be called — the USAGE_ERROR is raised before we reach the child.
    // We still provide a stub that fails loudly if called, to catch any regression where
    // the check is moved after the child call.
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --human-readable" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--human-readable"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Must have a non-zero exit code (USAGE_ERROR = 252)
    expect(exitCode).toBeDefined();
    // Output must contain a clear, overlay-generated error message — not the raw aws blob
    expect(output).toContain("--human-readable");
    // Must NOT be the opaque "Unknown options:" from s3api raw output
    expect(output).not.toContain("Unknown options");
  });

  // ── --summarize: USAGE_ERROR (display-only flag, no s3api equivalent) ──────
  //
  // Revert-proof: same as --human-readable above.

  it("s3 ls --summarize: overlay emits clean USAGE_ERROR (not an opaque s3api error)", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --summarize" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--summarize"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--summarize");
    expect(output).not.toContain("Unknown options");
  });

  // ── --page-size: valid s3api flag, must be forwarded verbatim ──────────────
  //
  // Verify that --page-size still reaches the child after the fix (i.e. our
  // changes don't accidentally absorb it).

  it("s3 ls s3://b/ --page-size 5: --page-size IS forwarded to s3api child", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--page-size",
      validStdout: ONE_OBJECT_RESPONSE,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--page-size", "5"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("USAGE_ERROR");
  });
});

// ── s3 head-object flag guard — issue #38 ────────────────────────────────────
//
// head-object maps to s3api head-object. If a user mistakenly passes an aws
// s3 display flag (--recursive, --human-readable) to head-object, it must
// produce a clean USAGE_ERROR rather than forwarding to s3api and dying with
// an opaque "Unknown options" message.
//
// Revert-proof: remove the --recursive USAGE_ERROR guard in the "head-object"
// case of s3Command → --recursive is forwarded to s3api head-object → stub
// returns the opaque s3api error; test expects a clean overlay USAGE_ERROR.

describe("s3 head-object flag guard — #38", () => {
  it("s3 head-object --recursive: overlay emits clean USAGE_ERROR", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --recursive" });

    const { output, exitCode } = await captureMain(
      ["s3", "head-object", "--bucket", "b", "--key", "k", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--recursive");
    // Must be the overlay's own clean message, not the raw s3api "Unknown options" dump
    expect(output).not.toContain("Unknown options");
  });
});
