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
import { useEnvGuard } from "./helpers/env-guard.js";

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
 *
 * When `requiredNextArg` is also supplied the stub checks that `requiredArg` is
 * immediately followed by that exact token — i.e. it asserts both the flag NAME
 * and its VALUE. This closes the mutation hole where a correct flag name but a
 * silently-swapped value (e.g. caller's 5 → default 50) would otherwise pass.
 *
 *   RED  (mutated): --max-items present but value swapped to 50
 *     → "5" token not immediately after "--max-items" → found stays 0
 *     → stub exits 1 → exitCode non-zero → expect(exitCode).toBeUndefined() FAILS.
 *   GREEN (correct): --max-items 5 forwarded verbatim → found=1 → exits 0 → PASSES.
 */
function createArgGuardStub(spec: {
  requiredArg: string;
  requiredNextArg?: string; // when set, the token immediately after requiredArg must equal this
  validStdout: string;
  fallbackStdout?: string; // when requiredArg is absent but we should NOT fail (e.g. secondary calls)
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-argguard-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");

  const missingMsg = spec.requiredNextArg
    ? `MISSING_PAIR: ${spec.requiredArg} ${spec.requiredNextArg} was not forwarded`
    : `MISSING_FLAG: ${spec.requiredArg} was not forwarded`;

  // Pair scan: requiredArg immediately followed by requiredNextArg.
  // Simple scan: just requiredArg presence.
  const scanLines = spec.requiredNextArg
    ? [
        "prev=",
        'for arg in "$@"; do',
        `  [ "$prev" = ${shellQuote(spec.requiredArg)} ] && [ "$arg" = ${shellQuote(spec.requiredNextArg)} ] && found=1`,
        '  prev="$arg"',
        "done",
      ]
    : [
        'for arg in "$@"; do',
        `  [ "$arg" = ${shellQuote(spec.requiredArg)} ] && found=1`,
        "done",
      ];

  const script = [
    "#!/bin/sh",
    "found=0",
    ...scanLines,
    'if [ "$found" = "1" ]; then',
    `  printf '%s' ${shellQuote(spec.validStdout)}`,
    "else",
    spec.fallbackStdout !== undefined
      ? `  printf '%s' ${shellQuote(spec.fallbackStdout)}`
      : `  printf '%s' ${shellQuote(missingMsg)} >&2 && exit 1`,
    "fi",
  ].join("\n");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Create a stub that exits 1 (with a diagnostic) if `bannedArg` IS present in
 * its argv. Proves that a flag was NOT forwarded when the test passes.
 *
 * Use this as the inverse of createArgGuardStub to assert cap-bypass: the stub
 * exits 1 when the banned flag is in the child argv, so:
 *   - RED (before fix): banned flag IS forwarded → stub exits 1 → test fails.
 *   - GREEN (after fix): banned flag absent     → stub exits 0 → test passes.
 */
function createArgBanStub(spec: {
  bannedArg: string;
  validStdout: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-argban-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const script = [
    "#!/bin/sh",
    "found=0",
    'for arg in "$@"; do',
    `  [ "$arg" = ${shellQuote(spec.bannedArg)} ] && found=1`,
    "done",
    'if [ "$found" = "1" ]; then',
    `  printf 'BANNED_FLAG: %s must not be forwarded when --query is active\\n' ${shellQuote(spec.bannedArg)} >&2`,
    "  exit 1",
    "fi",
    `printf '%s' ${shellQuote(spec.validStdout)}`,
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

// Guard the full process.env (and process.exitCode) around each test.
// See test/helpers/env-guard.ts for the rationale and the guard test.
useEnvGuard();

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
    const events = result.events as unknown[];
    expect(events.length).toBe(1);
    expect((events[0] as { message: string }).message).toContain("ERROR");
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

  // secretsmanager get-secret-value is special: --query without --reveal is a
  // hard USAGE_ERROR (PR #58 round-2).  AWS always returns SecretString in
  // plaintext; forwarding --query without opt-in would bypass redaction silently.
  //
  // ADR-0002 carve-out: --reveal is aws-axi's own flag; gating on it does NOT
  // violate the superset contract (we are guarding a confidentiality control
  // we invented, not restricting an input real aws accepts).
  //
  // Two sub-cases:
  //   (a) --query without --reveal → USAGE_ERROR 252
  //   (b) --query WITH --reveal   → bypass still works (caller opted in)

  it("secretsmanager get-secret-value --query without --reveal → USAGE_ERROR 252 (PR #58 round-2 guard)", async () => {
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify("secret-value"),
    });

    const { output, exitCode } = await captureMain(
      ["secretsmanager", "get-secret-value", "--secret-id", "my-secret", "--query", "SecretString"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Must fail with a USAGE_ERROR — not expose any secret value.
    expect(exitCode).toBe(252);
    expect(output).toContain("USAGE_ERROR");
    expect(output).toContain("--reveal");
  });

  it("secretsmanager get-secret-value --query WITH --reveal bypasses overlay projection, marker appears in output", async () => {
    const MARKER = "secret-bypass-ok";
    // With --reveal: the caller has opted in; --query bypass is permitted.
    const binary = createArgGuardStub({
      requiredArg: "--query",
      validStdout: JSON.stringify(MARKER),
    });

    const { output, exitCode } = await captureMain(
      ["secretsmanager", "get-secret-value", "--secret-id", "my-secret", "--reveal", "--query", "SecretString"],
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
// s3 ls rewrites to s3api (list-buckets for no-URI, list-objects-v2 for prefix).
// Each aws s3-level flag must be handled deliberately — not blindly forwarded
// into a child that will reject them, and not silently dropped.
//
// Full flag × path matrix (implemented in s3Command):
//   --recursive (prefix)       → drops --delimiter / (real semantic; NOT forwarded)
//   --recursive (no-URI)       → USAGE_ERROR (listing buckets has no recursion)
//   --human-readable (both)    → USAGE_ERROR (display-only)
//   --summarize (both)         → USAGE_ERROR (display-only)
//   --page-size (prefix)       → forwarded verbatim (valid list-objects-v2 flag)
//   --request-payer (prefix)   → forwarded verbatim (valid list-objects-v2 flag)
//   --request-payer (no-URI)   → USAGE_ERROR (invalid for list-buckets)
//   --bucket-name-prefix (no-URI) → translated to --prefix (list-buckets param)
//   --bucket-name-prefix (prefix) → USAGE_ERROR (filters bucket names, not objects)
//   --bucket-region (no-URI)   → forwarded verbatim (valid list-buckets filter)
//   --bucket-region (prefix)   → USAGE_ERROR (filters bucket list, not objects)
//
// Default delimiter behavior (blocker 1 from review):
//   s3 ls s3://b/ (no --recursive) → --delimiter / IS sent (matches real aws s3 ls)
//   s3 ls s3://b/ --recursive      → --delimiter is NOT sent (all nested keys returned)
//
// CommonPrefixes (blocker 1 from review):
//   When --delimiter / is active, S3 returns CommonPrefixes ("folder" entries).
//   Projection maps them to prefixes[]. Folder-only buckets must NOT report empty.

/**
 * Stub that FAILS (exits 252) if `rejectedArg` appears anywhere in its argv.
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

/**
 * Stub that:
 *  - FAILS (exits 252) if `rejectedArg` appears in argv.
 *  - FAILS (exits 1)   if `requiredArg` is absent from argv.
 *  - Exits 0 with validStdout otherwise.
 *
 * Used to prove a flag was TRANSLATED (not forwarded verbatim):
 * the original flag is rejected, the translated flag is required.
 */
function createTranslationGuardStub(spec: {
  rejectedArg: string;
  requiredArg: string;
  validStdout: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-translate-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const script = [
    "#!/bin/sh",
    "has_rejected=0",
    "has_required=0",
    "for arg in \"$@\"; do",
    `  [ "$arg" = ${shellQuote(spec.rejectedArg)} ] && has_rejected=1`,
    `  [ "$arg" = ${shellQuote(spec.requiredArg)} ] && has_required=1`,
    "done",
    `if [ "$has_rejected" = "1" ]; then`,
    `  printf 'REJECTED: %s was forwarded verbatim (expected translation)\\n' ${shellQuote(spec.rejectedArg)} >&2`,
    "  exit 252",
    "fi",
    `if [ "$has_required" != "1" ]; then`,
    `  printf 'MISSING: %s was not found in argv\\n' ${shellQuote(spec.requiredArg)} >&2`,
    "  exit 1",
    "fi",
    `printf '%s' ${shellQuote(spec.validStdout)}`,
    "exit 0",
  ].join("\n");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

/** Minimal list-objects-v2 response with one object (no CommonPrefixes). */
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

/** list-objects-v2 response with NO objects but two CommonPrefixes (folder-only bucket). */
const FOLDERS_ONLY_RESPONSE = JSON.stringify({
  Contents: [],
  CommonPrefixes: [
    { Prefix: "logs/" },
    { Prefix: "data/" },
  ],
  KeyCount: 0,
  MaxKeys: 20,
  IsTruncated: false,
  Name: "bucket",
  Prefix: "",
});

/** list-buckets response (for no-URI path tests). */
const LIST_BUCKETS_RESP = JSON.stringify({
  Buckets: [
    { Name: "my-bucket", CreationDate: "2024-01-01T00:00:00+00:00" },
  ],
  Owner: { DisplayName: "me", ID: "abc" },
});

describe("s3 ls flag translation — #38", () => {
  // ── Blocker 1: default delimiter behavior ─────────────────────────────────
  //
  // Real `aws s3 ls s3://b/` sends ?delimiter=%2F; aws-axi's default did NOT
  // (it behaved like --recursive). The fix adds --delimiter / by default.
  //
  // Revert-proof: remove `args.push("--delimiter", "/")` from s3LsRun →
  //   test "default sends --delimiter" goes RED (stub requires --delimiter, doesn't get it).
  //   test "recursive drops --delimiter" goes RED (stub rejects --delimiter, gets it).

  it("s3 ls s3://b/ (no --recursive): --delimiter / IS sent to s3api child", async () => {
    // Stub requires --delimiter in argv; exits 1 if absent.
    // Before fix: no --delimiter sent → stub exits 1 (MISSING_FLAG) → test fails.
    // After fix:  --delimiter / sent by default → stub exits 0 → test passes.
    const binary = createArgGuardStub({
      requiredArg: "--delimiter",
      validStdout: ONE_OBJECT_RESPONSE,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("file.txt");
  });

  it("s3 ls s3://b/ --recursive: --delimiter is NOT sent to s3api child", async () => {
    // Stub exits 252 if --delimiter appears in argv.
    // Before fix: no --delimiter sent regardless → stub exits 0 (accidentally GREEN).
    // After fix:  --recursive drops the delimiter → stub exits 0 (correctly GREEN).
    // Proven via "default sends delimiter" test: without the fix that test is RED,
    // proving the default did NOT send a delimiter — so this test was vacuously true
    // before the fix. Both tests together prove the fix is load-bearing.
    const binary = createRejectArgStub({
      rejectedArg: "--delimiter",
      validStdout: ONE_OBJECT_RESPONSE,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("file.txt");
  });

  // ── Blocker 1: CommonPrefixes — folder-only bucket must NOT report empty ──
  //
  // Revert-proof: remove `const prefixes = (resp.CommonPrefixes ?? []).map(...)` and
  // keep `if (objects.length === 0) return { empty: true }` → test goes RED because
  // a folder-only response still hits the empty path and outputs "No objects found".

  it("s3 ls s3://b/: folder-only bucket (CommonPrefixes, empty Contents) is NOT reported as empty", async () => {
    // Without the fix: Contents=[] → objects.length===0 → empty: true → "No objects found".
    // After fix: prefixes=[{prefix:"logs/"},{prefix:"data/"}] → totalItems=2 → not empty.
    const binary = createStub({ stdout: FOLDERS_ONLY_RESPONSE, exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("No objects found");
    expect(output).toContain("logs/");
    expect(output).toContain("data/");
  });

  // ── --recursive: must NOT be forwarded to s3api child (drops delimiter only) ─
  //
  // Revert-proof: remove ["--recursive"] from ownedBoolFlags in s3Command →
  // --recursive reaches stub → stub exits 252 → test fails.

  it("s3 ls s3://b/ --recursive: --recursive is NOT forwarded to s3api child", async () => {
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
    expect(output).toContain("objects");
  });

  it("s3 ls s3://b/ --recursive: returns enriched object listing (no spurious empty)", async () => {
    const binary = createStub({ stdout: ONE_OBJECT_RESPONSE, exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("No objects found");
    expect(output).toContain("file.txt");
  });

  // ── --human-readable: USAGE_ERROR (both paths) ───────────────────────────
  //
  // Revert-proof: remove the --human-readable guard → forwarded to s3api →
  // stub emits "Unknown options: --human-readable" → test expects clean overlay error.

  it("s3 ls --human-readable: overlay emits clean USAGE_ERROR (not opaque s3api error)", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --human-readable" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--human-readable"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--human-readable");
    expect(output).not.toContain("Unknown options");
  });

  // ── --summarize: USAGE_ERROR (both paths) ────────────────────────────────

  it("s3 ls --summarize: overlay emits clean USAGE_ERROR (not opaque s3api error)", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --summarize" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--summarize"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--summarize");
    expect(output).not.toContain("Unknown options");
  });

  // ── --page-size: forwarded verbatim to list-objects-v2 (already works) ───

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

  // ── Blocker 2: --bucket-name-prefix → --prefix translation (no-URI path) ─
  //
  // `aws s3 ls --bucket-name-prefix foo` → s3api list-buckets --prefix foo
  // (--bucket-name-prefix is an aws s3 flag; --prefix is the list-buckets param)
  //
  // Revert-proof: remove the bucket-name-prefix extraction and --prefix injection
  // from s3Command → --bucket-name-prefix forwarded verbatim → s3api exits 252 →
  // translationGuard stub sees the REJECTED arg → test fails.

  it("s3 ls --bucket-name-prefix foo: translated to --prefix foo for list-buckets (NOT forwarded verbatim)", async () => {
    // Stub exits 252 if --bucket-name-prefix appears (untranslated).
    // Stub exits 1  if --prefix is absent (translation didn't happen).
    // Exits 0 when --prefix is present and --bucket-name-prefix is absent.
    // Before fix: --bucket-name-prefix forwarded → stub exits 252 → test fails.
    // After fix:  --prefix injected, --bucket-name-prefix stripped → stub exits 0.
    const binary = createTranslationGuardStub({
      rejectedArg: "--bucket-name-prefix",
      requiredArg: "--prefix",
      validStdout: LIST_BUCKETS_RESP,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "--bucket-name-prefix", "foo"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).not.toContain("REJECTED");
    expect(output).not.toContain("MISSING");
    expect(output).toContain("my-bucket");
  });

  // ── Blocker 2: --recursive on no-URI path → USAGE_ERROR ─────────────────
  //
  // Revert-proof: remove the --recursive guard for the no-URI path → --recursive
  // is forwarded to list-buckets → list-buckets rejects it → stub's "Unknown
  // options" message appears; test expects overlay USAGE_ERROR.

  it("s3 ls --recursive (no URI): USAGE_ERROR — listing buckets has no recursion concept", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --recursive" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--recursive");
    expect(output).not.toContain("Unknown options");
  });

  // ── Blocker 2: --request-payer on no-URI path → USAGE_ERROR ─────────────
  //
  // --request-payer is valid for list-objects-v2 but NOT for list-buckets.
  // Revert-proof: remove the guard → forwarded to list-buckets → s3api rejects it.

  it("s3 ls --request-payer requester (no URI): USAGE_ERROR — not valid for list-buckets", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --request-payer" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "--request-payer", "requester"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--request-payer");
    expect(output).not.toContain("Unknown options");
  });

  // ── Blocker 2: --bucket-name-prefix on prefix path → USAGE_ERROR ─────────

  it("s3 ls s3://b/ --bucket-name-prefix foo: USAGE_ERROR — filters bucket names, not objects", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --bucket-name-prefix" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--bucket-name-prefix", "foo"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--bucket-name-prefix");
    expect(output).not.toContain("Unknown options");
  });

  // ── Blocker 2: --bucket-region on prefix path → USAGE_ERROR ─────────────

  it("s3 ls s3://b/ --bucket-region us-east-1: USAGE_ERROR — filters bucket list, not objects", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --bucket-region" });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--bucket-region", "us-east-1"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--bucket-region");
    expect(output).not.toContain("Unknown options");
  });
});

// ── s3 head-object flag guard — issue #38 ────────────────────────────────────
//
// head-object maps to s3api head-object. If a user mistakenly passes an aws
// s3 display flag (--recursive) to head-object, it must produce a clean
// USAGE_ERROR rather than forwarding to s3api and dying with an opaque message.
//
// Revert-proof: remove the --recursive USAGE_ERROR guard in the "head-object"
// case of s3Command → --recursive is forwarded → stub emits "Unknown options".

describe("s3 head-object flag guard — #38", () => {
  it("s3 head-object --recursive: overlay emits clean USAGE_ERROR", async () => {
    const binary = createStub({ exitCode: 252, stderr: "Unknown options: --recursive" });

    const { output, exitCode } = await captureMain(
      ["s3", "head-object", "--bucket", "b", "--key", "k", "--recursive"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeDefined();
    expect(output).toContain("--recursive");
    expect(output).not.toContain("Unknown options");
  });
});

// ── s3 ls --starting-token on no-URI (list-buckets) path — issue #44 ─────────
//
// `aws s3api list-buckets` is a genuine paginated operation: botocore ships a
// ListBuckets paginator with ContinuationToken as both input and output token,
// and `aws s3api list-buckets help` shows `[--starting-token <value>]` in the
// SYNOPSIS. S3_HELP advertises --starting-token for all ls paths. Before the
// fix, the token was extracted in s3Command but never forwarded to the child
// aws process on the no-URI path — a silent drop.
//
// Pagination contract (engine.ts rule): --starting-token engages the botocore
// client-side paginator, which auto-pages to the end and emits a synthesized
// NextToken ONLY when --max-items truncates. ContinuationToken is stripped by
// botocore and NEVER appears in the child's stdout. Truncation is gated on
// NextToken (the botocore-synthesized field), never on ContinuationToken.
//
// The fix adds:
//   1. --max-items S3_PAGE_SIZE to the list-buckets args (caps the response)
//   2. --starting-token forwarding (bug fix for issue #44)
//   3. Truncation gated on NextToken (honest, fireable)
//
// The tests drive the FULL CLI adapter (captureMain) through PATH-injected
// stubs. Only captureMain exercises the full s3Command→s3LsRun chain.
//
// Revert-proof coverage:
//   A. Remove --starting-token push → guard stub exits 1 → FAILS
//   B. Remove --max-items push → cap guard stub exits 1 → FAILS
//   C. Remove NextToken gate → no truncated/nextToken in output → FAILS

/** Realistic list-buckets response when --starting-token is present (no more pages). */
const LIST_BUCKETS_WITH_PAGINATION = JSON.stringify({
  Buckets: [
    { Name: "my-bucket", CreationDate: "2024-01-01T00:00:00+00:00" },
  ],
  Owner: { DisplayName: "me", ID: "abc" },
});

/**
 * list-buckets response with a synthesized NextToken — what botocore emits
 * when --max-items truncates the result. ContinuationToken is NOT present:
 * botocore strips the native output token and emits NextToken instead.
 */
const LIST_BUCKETS_TRUNCATED = JSON.stringify({
  Buckets: [
    { Name: "my-bucket", CreationDate: "2024-01-01T00:00:00+00:00" },
  ],
  Owner: { DisplayName: "me", ID: "abc" },
  NextToken: "eyJDb250aW51YXRpb25Ub2tlbiI6ICJuZXh0cGFnZTQ1NiJ9",
});

describe("s3 ls --starting-token on no-URI path — issue #44", () => {
  it("s3 ls --starting-token TOKEN123 (no URI): --starting-token IS forwarded to s3api list-buckets child", async () => {
    // Stub requires --starting-token in argv; exits 1 if absent.
    // Before fix: no --starting-token forwarded → stub exits 1 → captureMain exits
    //   with non-zero code → expect(exitCode).toBeUndefined() FAILS → test RED.
    // After fix:  --starting-token TOKEN123 forwarded → stub exits 0 with valid JSON
    //   → output contains "my-bucket" → test GREEN.
    const binary = createArgGuardStub({
      requiredArg: "--starting-token",
      validStdout: LIST_BUCKETS_WITH_PAGINATION,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "--starting-token", "TOKEN123"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // No rejection error — the token was forwarded and the stub accepted it.
    expect(exitCode).toBeUndefined();
    // Output must include bucket data (not an error or MISSING_FLAG diagnostic).
    expect(output).toContain("my-bucket");
    expect(output).not.toContain("MISSING_FLAG");
  });

  it("s3 ls --starting-token TOKEN123 (no URI): enriched bucket listing returned (not empty, not error)", async () => {
    // Secondary check: the overlay must still apply its curated projection
    // (buckets[] with name + creationDate) even when --starting-token is present.
    const binary = createArgGuardStub({
      requiredArg: "--starting-token",
      validStdout: LIST_BUCKETS_WITH_PAGINATION,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "--starting-token", "TOKEN123"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    // Enriched projection: buckets[] with name/creationDate fields.
    expect(output).toContain("buckets");
    expect(output).toContain("2024-01-01");
    expect(output).not.toContain("No buckets found");
  });

  it("s3 ls (no URI): --max-items IS forwarded to s3api list-buckets child (cap enforcement)", async () => {
    // Stub exits 1 if --max-items is absent from child argv.
    // Revert-proof: remove the "--max-items" push from lsBucketsArgs →
    //   child never receives --max-items → stub exits 1 → exitCode non-zero →
    //   expect(exitCode).toBeUndefined() FAILS → test RED.
    // After fix: --max-items S3_PAGE_SIZE forwarded → stub exits 0 → GREEN.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      validStdout: LIST_BUCKETS_WITH_PAGINATION,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("my-bucket");
    expect(output).not.toContain("MISSING_FLAG");
  });

  it("s3 ls (no URI): truncated: true + nextToken reported when stub emits NextToken (--max-items cap fired)", async () => {
    // Stub returns LIST_BUCKETS_TRUNCATED — a realistic response shape for when
    // botocore's --max-items paginator fires: Buckets + Owner + synthesized NextToken.
    // ContinuationToken is NOT present (botocore strips it).
    //
    // Revert-proof: remove the `if (resp.NextToken !== undefined)` gate →
    //   overlay returns { buckets } with no truncated/nextToken fields →
    //   expect(output).toContain("truncated") FAILS → test RED.
    const binary = createStub({ stdout: LIST_BUCKETS_TRUNCATED });

    const { output, exitCode } = await captureMain(
      ["s3", "ls"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("my-bucket");
    expect(output).toContain("truncated");
    expect(output).toContain("nextToken");
    // Confirm the synthesized base64 token (not a raw ContinuationToken) is surfaced.
    expect(output).toContain("eyJDb250aW51YXRpb25Ub2tlbiI6ICJuZXh0cGFnZTQ1NiJ9");
  });
});

// ── --query cap bypass: --max-items must NOT be forwarded when --query is active ──
//
// When --query is active, the aws CLI applies JMESPath to the response before
// returning it. JMESPath projects NextToken away — so if --max-items were still
// forwarded, the overlay would silently truncate the result at S3_PAGE_SIZE with
// zero indication that anything was missing.
//
// The fix: skip --max-items when hasQuery === true on both ls paths. Without the
// cap, botocore auto-pages the complete result (same semantics as real `aws`).
//
// Revert-proof (both tests):
//   - Restore --max-items push inside lsBucketsArgs (or args for objects) before the
//     hasQuery check → ban stub receives --max-items → exits 1 → exitCode non-zero
//     → expect(exitCode).toBeUndefined() FAILS → test RED.
//   - With fix in place: --max-items absent from child argv → ban stub exits 0 → GREEN.

/** Simulated --query 'Buckets[].Name' output: 25 names (more than S3_PAGE_SIZE=20). */
const QUERY_BUCKETS_NAMES = JSON.stringify(
  Array.from({ length: 25 }, (_, i) => `bucket-${String(i).padStart(3, "0")}`),
);

/** Simulated --query 'Contents[].Key' output: 25 keys (more than S3_PAGE_SIZE=20). */
const QUERY_OBJECTS_KEYS = JSON.stringify(
  Array.from({ length: 25 }, (_, i) => `file-${String(i).padStart(3, "0")}.txt`),
);

describe("s3 ls --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("s3 ls --query (no URI): --max-items is NOT forwarded to s3api list-buckets child", async () => {
    // Ban stub: exits 1 with a diagnostic if --max-items appears in child argv.
    //
    // RED  (before fix): lsBucketsArgs always contains --max-items → ban stub exits 1
    //        → captureMain sets exitCode → expect(exitCode).toBeUndefined() FAILS.
    // GREEN (after  fix): --max-items skipped when hasQuery → ban stub exits 0 → PASSES.
    //
    // The stub also returns 25 bucket names — more than S3_PAGE_SIZE(20) — proving
    // the full result is returned without silent truncation when the cap is absent.
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: QUERY_BUCKETS_NAMES,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "--query", "Buckets[].Name"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // Ban stub exited 0 — --max-items was not in child argv.
    expect(exitCode).toBeUndefined();
    // Raw JMESPath result is returned (not the curated buckets[] projection).
    expect(output).toContain("bucket-000");
    expect(output).toContain("bucket-024"); // index 24 = the 25th item, past the old cap
    expect(output).not.toContain("BANNED_FLAG");
  });

  it("s3 ls s3://b/ --query (objects path): --max-items is NOT forwarded to s3api list-objects-v2 child", async () => {
    // Identical guard on the objects path. Both paths had the same silent-truncation
    // hole since 0.2.0 (the objects path is the older seam); fixed together.
    //
    // RED  (before fix): args always contains --max-items → ban stub exits 1 → FAILS.
    // GREEN (after  fix): --max-items skipped when hasQuery → ban stub exits 0 → PASSES.
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: QUERY_OBJECTS_KEYS,
    });

    const { output, exitCode } = await captureMain(
      ["s3", "ls", "s3://b/", "--query", "Contents[].Key"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("file-000.txt");
    expect(output).toContain("file-024.txt"); // 25th item, past the old cap
    expect(output).not.toContain("BANNED_FLAG");
  });
});

// ── IAM --query cap bypass (issue #47) ───────────────────────────────────────
//
// All three IAM paginated overlays (list-roles, list-policies,
// list-attached-role-policies) formerly pushed --max-items unconditionally.
// The fix gates each push on `!hasQuery`.
//
// Ban-stub approach: the stub exits 1 if --max-items appears in child argv.
//   RED  (before fix): overlay pushed --max-items → stub exits 1 → captureMain
//     records a non-zero exitCode → expect(exitCode).toBeUndefined() FAILS.
//   GREEN (after fix): push suppressed when hasQuery → stub exits 0 → PASSES.

describe("iam --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("iam list-roles --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["role-a", "role-b"]),
    });

    const { exitCode } = await captureMain(
      ["iam", "list-roles", "--query", "Roles[].RoleName"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("iam list-policies --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["policy-a", "policy-b"]),
    });

    const { exitCode } = await captureMain(
      ["iam", "list-policies", "--query", "Policies[].PolicyName"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("iam list-attached-role-policies <role> --query: --max-items NOT forwarded", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["arn:aws:iam::aws:policy/AdministratorAccess"]),
    });

    const { exitCode } = await captureMain(
      [
        "iam",
        "list-attached-role-policies",
        "my-role",
        "--query",
        "AttachedPolicies[].PolicyArn",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── KMS --query cap bypass (issue #47) ───────────────────────────────────────
//
// list-keys and list-aliases both owned --max-items (MAX_ITEMS_DEFAULT = 50).
// The fix adds `explicitMaxItems` detection: cap is only pushed when
// !hasQuery OR the user explicitly provided --max-items.

describe("kms --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("kms list-keys --query: --max-items NOT forwarded to child", async () => {
    // list-keys returns early when hasQuery=true (no secondary alias call).
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["key-id-1", "key-id-2"]),
    });

    const { exitCode } = await captureMain(
      ["kms", "list-keys", "--query", "Keys[].KeyId"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("kms list-aliases --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["alias/my-key"]),
    });

    const { exitCode } = await captureMain(
      ["kms", "list-aliases", "--query", "Aliases[].AliasName"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── Lambda --query cap bypass (issue #47) ────────────────────────────────────

describe("lambda --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("lambda list-functions --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["fn-a", "fn-b"]),
    });

    const { exitCode } = await captureMain(
      ["lambda", "list-functions", "--query", "Functions[].FunctionName"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── Logs --query cap bypass (issue #47) ──────────────────────────────────────
//
// tailRun gates the --max-items push on `!hasQuery || limit !== undefined`.
// When --query is present and --limit is absent, limit is undefined → cap suppressed.
// describeLogGroupsRun applies the same logic.

describe("logs --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("logs tail <group> --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify("event-message-text"),
    });

    const { exitCode } = await captureMain(
      ["logs", "tail", "/test/log-group", "--query", "events[0].message"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("logs describe-log-groups --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["/aws/lambda/fn"]),
    });

    const { exitCode } = await captureMain(
      ["logs", "describe-log-groups", "--query", "logGroups[0].logGroupName"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── Secrets --query cap bypass (issue #47) ───────────────────────────────────

describe("secretsmanager --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("secretsmanager list-secrets --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["secret-a", "secret-b"]),
    });

    const { exitCode } = await captureMain(
      ["secretsmanager", "list-secrets", "--query", "SecretList[].Name"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── SSM --query cap bypass (issue #47) ───────────────────────────────────────

describe("ssm --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("ssm get-parameters-by-path --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["/my/app/key"]),
    });

    const { exitCode } = await captureMain(
      [
        "ssm",
        "get-parameters-by-path",
        "--path",
        "/my/app",
        "--query",
        "Parameters[].Name",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("ssm describe-parameters --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["/my/app/key"]),
    });

    const { exitCode } = await captureMain(
      ["ssm", "describe-parameters", "--query", "Parameters[].Name"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── EC2 --query cap bypass (issue #47) ───────────────────────────────────────
//
// ec2Run used buildPaginationArgs({ maxItems: DEFAULT_MAX_ITEMS }) in the hasQuery
// branch; replaced with a conditional push that only fires when
// normalizedOptions.maxItems !== undefined.

describe("ec2 --query cap bypass — --max-items NOT forwarded when --query active", () => {
  it("ec2 describe-vpcs --query: --max-items NOT forwarded to child", async () => {
    const binary = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: JSON.stringify(["vpc-abc123", "vpc-def456"]),
    });

    const { exitCode } = await captureMain(
      ["ec2", "describe-vpcs", "--query", "Vpcs[].VpcId"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});

// ── Re-cap guard: --query + explicit cap → cap IS forwarded with caller's value ──
//
// ADR-0002 "re-cap" half: when --query is present AND the caller explicitly
// supplies a cap flag (--max-items N on most overlays; --limit N on logs),
// that explicit cap MUST still reach the child process with the CALLER'S VALUE —
// botocore honors it as a hard limit on the total auto-paged result.
//
// Each test uses createArgGuardStub with both requiredArg AND requiredNextArg so
// the stub asserts the flag NAME ("--max-items") AND the immediate next token
// (the caller's value, e.g. "5" or "3"). A value-swap mutation — where the code
// pushes the default instead of the caller's value — is caught:
//   Mutation: `awsArgs.push("--max-items", String(hasQuery ? 50 : maxItems))`
//     → child receives --max-items 50 (not 5) → "5" ≠ "50" → found stays 0
//     → stub exits 1 → exitCode set → expect(exitCode).toBeUndefined() FAILS → RED.
//
// Absence mutation proof: deleting `|| explicitMaxItems` from kms.ts:runListKeys,
// kms.ts:runListAliases, and lambda.ts:runListFunctions turns those three
// tests RED (the others prove similar mutations in their own overlays).
//
// Note on IAM: iam does not own --max-items (it flows via passthrough, not an
// explicit push), so the re-cap is structurally different — the guard test for
// iam is a regression gate against future changes that might own the flag
// without forwarding it.

describe("--query + explicit cap: re-cap IS forwarded to child (guard stubs)", () => {
  // ── KMS ×2 ────────────────────────────────────────────────────────────────

  it("kms list-keys --query --max-items 5: --max-items 5 forwarded to child", async () => {
    // list-keys returns early when hasQuery=true (no secondary list-aliases call),
    // so the guard stub is only invoked once.
    //
    // Mutation: delete `|| explicitMaxItems` in kms.ts runListKeys:
    //   `!hasQuery || false` → cap skipped → stub exits 1 → RED.
    //
    // Value-swap mutation: `String(hasQuery ? 50 : maxItems)` silently replaces
    //   caller's 5 with 50. requiredNextArg catches this: --max-items 50 ≠ --max-items 5
    //   → found stays 0 → stub exits 1 → RED.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["key-id-1"]),
    });

    const { exitCode } = await captureMain(
      ["kms", "list-keys", "--query", "Keys[].KeyId", "--max-items", "5"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("kms list-aliases --query --max-items 5: --max-items 5 forwarded to child", async () => {
    // Mutation: delete `|| explicitMaxItems` in kms.ts runListAliases → RED.
    // Value-swap: stub requires the exact "5" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["alias/my-key"]),
    });

    const { exitCode } = await captureMain(
      [
        "kms",
        "list-aliases",
        "--query",
        "Aliases[].AliasName",
        "--max-items",
        "5",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  // ── Lambda ────────────────────────────────────────────────────────────────

  it("lambda list-functions --query --max-items 5: --max-items 5 forwarded to child", async () => {
    // Mutation: delete `|| explicitMaxItems` in lambda.ts runListFunctions → RED.
    // Value-swap: stub requires the exact "5" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["fn-a"]),
    });

    const { exitCode } = await captureMain(
      [
        "lambda",
        "list-functions",
        "--query",
        "Functions[].FunctionName",
        "--max-items",
        "5",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  // ── Secrets ───────────────────────────────────────────────────────────────

  it("secretsmanager list-secrets --query --max-items 5: --max-items 5 forwarded to child", async () => {
    // Value-swap: stub requires the exact "5" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["secret-a"]),
    });

    const { exitCode } = await captureMain(
      [
        "secretsmanager",
        "list-secrets",
        "--query",
        "SecretList[].Name",
        "--max-items",
        "5",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  // ── SSM ×2 ────────────────────────────────────────────────────────────────

  it("ssm get-parameters-by-path --query --max-items 5: --max-items 5 forwarded to child", async () => {
    // Value-swap: stub requires the exact "5" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["/my/app/key"]),
    });

    const { exitCode } = await captureMain(
      [
        "ssm",
        "get-parameters-by-path",
        "--path",
        "/my/app",
        "--query",
        "Parameters[].Name",
        "--max-items",
        "5",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("ssm describe-parameters --query --max-items 5: --max-items 5 forwarded to child", async () => {
    // Value-swap: stub requires the exact "5" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["/my/app/key"]),
    });

    const { exitCode } = await captureMain(
      [
        "ssm",
        "describe-parameters",
        "--query",
        "Parameters[].Name",
        "--max-items",
        "5",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  // ── EC2 ───────────────────────────────────────────────────────────────────

  it("ec2 describe-vpcs --query --max-items 5: --max-items 5 forwarded to child", async () => {
    // Value-swap: stub requires the exact "5" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["vpc-abc123"]),
    });

    const { exitCode } = await captureMain(
      ["ec2", "describe-vpcs", "--query", "Vpcs[].VpcId", "--max-items", "5"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  // ── IAM ───────────────────────────────────────────────────────────────────

  it("iam list-roles --query --max-items 5: --max-items 5 forwarded via passthrough", async () => {
    // IAM does not own --max-items (no extractFlag call) — it flows verbatim via
    // passthrough. Guard verifies it still reaches the child.
    // Value-swap: stub requires the exact "5" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "5",
      validStdout: JSON.stringify(["role-a"]),
    });

    const { exitCode } = await captureMain(
      ["iam", "list-roles", "--query", "Roles[].RoleName", "--max-items", "5"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  // ── Logs ×2 (includes Blocker 1: --limit=<n> equals form) ────────────────
  //
  // logs uses --limit (not --max-items) as the user-facing cap flag; tailRun
  // and describeLogGroupsRun translate it to --max-items for the child call.
  //
  // Blocker 1 fix: pullFlag now handles the --limit=3 equals form.
  //   Before fix: --limit=3 not parsed → options.limit=undefined
  //     → guard `!hasQuery || undefined` = false → --max-items not pushed
  //     → stub exits 1 → exitCode non-zero → test RED.
  //   After fix: --limit=3 parsed as limit=3
  //     → guard `!hasQuery || 3!==undefined` = true → --max-items 3 pushed
  //     → stub exits 0 → test GREEN.

  it("logs tail --query --limit 3 (space form): --max-items 3 forwarded to child", async () => {
    // Value-swap: stub requires the exact "3" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "3",
      validStdout: JSON.stringify({ events: [] }),
    });

    const { exitCode } = await captureMain(
      [
        "logs",
        "tail",
        "/test/log-group",
        "--query",
        "events[0].message",
        "--limit",
        "3",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("logs tail --query --limit=3 (equals form, Blocker 1): --max-items 3 forwarded to child", async () => {
    // RED  (before pullFlag fix): --limit=3 not parsed → options.limit=undefined
    //   → guard false → --max-items not pushed → stub exits 1 → FAILS.
    // GREEN (after pullFlag fix): --limit=3 → limit=3 → --max-items 3 pushed → PASSES.
    // Value-swap: stub requires the exact "3" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "3",
      validStdout: JSON.stringify({ events: [] }),
    });

    const { exitCode } = await captureMain(
      [
        "logs",
        "tail",
        "/test/log-group",
        "--query",
        "events[0].message",
        "--limit=3",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });

  it("logs describe-log-groups --query --limit=3 (equals form): --max-items 3 forwarded to child", async () => {
    // Value-swap: stub requires the exact "3" token after "--max-items" → RED if 50.
    const binary = createArgGuardStub({
      requiredArg: "--max-items",
      requiredNextArg: "3",
      validStdout: JSON.stringify({ logGroups: [] }),
    });

    const { exitCode } = await captureMain(
      [
        "logs",
        "describe-log-groups",
        "--query",
        "logGroups[].logGroupName",
        "--limit=3",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
  });
});
