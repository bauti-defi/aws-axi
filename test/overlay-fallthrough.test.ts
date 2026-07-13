/**
 * E2E tests for overlay fall-through (issue #30).
 *
 * Verifies the "enrich hot path, fall through to engine" design:
 *   1. Overlay-implemented ops still route to the overlay (e.g. ec2 describe-vpcs
 *      produces the curated projection, not raw engine output).
 *   2. Unimplemented-but-real overlay ops fall through to the engine (e.g.
 *      ec2 describe-regions returns structured output, NOT a USAGE_ERROR).
 *   3. A completely bogus op still produces a clean structured error via the
 *      engine's own "unknown operation" path (not the overlay's allowlist error).
 *   4. The uniform fall-through applies to at least two overlays (ec2 + logs).
 *
 * Uses the same real-exec-stub pattern as cli-engine.test.ts — no function
 * mocks, only a real shell script injected via PATH or the binary seam.
 * The fake ec2 and logs botocore models live in test/fixtures/.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ── Stub helpers ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

interface StubSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createStub(spec: StubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-fallthrough-"));
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Capture stdout + exitCode from main(), same approach as cli-engine.test.ts. */
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

function stubPath(binary: string): string {
  return binary.replace(/\/aws$/, "");
}

// ── EC2 overlay tests ─────────────────────────────────────────────────────────

describe("overlay fall-through — ec2", () => {
  it("describe-vpcs still routes to the overlay (curated projection, not engine)", async () => {
    // The ec2 overlay projects VPCs into a curated { vpcs: [...], count } shape.
    // The engine would return raw { Vpcs: [...] } from the stub.
    const stub = createStub({
      stdout: JSON.stringify({
        Vpcs: [
          {
            VpcId: "vpc-abc123",
            CidrBlock: "10.0.0.0/16",
            State: "available",
            IsDefault: false,
            OwnerId: "123456789012",
            Tags: [{ Key: "Name", Value: "test-vpc" }],
          },
        ],
      }),
      exitCode: 0,
    });

    const { output, exitCode } = await captureMain(
      ["ec2", "describe-vpcs"],
      {
        PATH: `${stubPath(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    // Overlay projection: TOON table format with lowercase "vpcs" header and "count" field.
    // Engine would emit raw uppercase "Vpcs" from the stub JSON.
    expect(output).toContain("vpcs");
    expect(output).toContain("count");
    // Overlay uses lowercase field names in the TOON table header
    expect(output).toContain("id");
    expect(output).toContain("test-vpc");
    // Raw engine format would emit "Vpcs" (uppercase) — overlay transforms to lowercase
    expect(output).not.toContain("USAGE_ERROR");
    expect(exitCode).toBeUndefined();
  });

  it("describe-regions falls through to the engine (not a USAGE_ERROR)", async () => {
    // describe-regions is NOT in the ec2 overlay's allowlist but IS a real AWS op.
    // After the fix, the overlay delegates to the engine which calls the stub.
    const stub = createStub({
      stdout: JSON.stringify({
        Regions: [
          { RegionName: "us-east-1", Endpoint: "ec2.us-east-1.amazonaws.com" },
          { RegionName: "us-west-2", Endpoint: "ec2.us-west-2.amazonaws.com" },
        ],
      }),
      exitCode: 0,
    });

    const { output, exitCode } = await captureMain(
      ["ec2", "describe-regions"],
      {
        PATH: `${stubPath(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    // Engine ran — should see the regions data
    expect(output).toContain("us-east-1");
    expect(output).toContain("us-west-2");
    // Must NOT be a USAGE_ERROR ("Unknown ec2 operation")
    expect(output).not.toContain("USAGE_ERROR");
    expect(output).not.toContain("Unknown ec2 operation");
    expect(exitCode).toBeUndefined();
  });

  it("a bogus op unknown to the EC2 model still errors cleanly via the engine", async () => {
    // totally-bogus-op is neither in the ec2 overlay nor in the botocore ec2 model.
    // The error should now come from the engine's validation path, not the overlay's
    // hardcoded allowlist. Both give USAGE_ERROR (exit 252), but the message differs.
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["ec2", "totally-bogus-op"],
      {
        PATH: `${stubPath(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    // The engine's "unknown operation" error message (not the overlay's allowlist message)
    expect(output).toContain("totally-bogus-op");
    expect(output).toContain("USAGE_ERROR");
    // Exit 252 = USAGE_ERROR in aws-axi taxonomy
    expect(exitCode).toBe(252);
  });
});

// ── Logs overlay tests ────────────────────────────────────────────────────────

describe("overlay fall-through — logs", () => {
  it("describe-log-groups still routes to the overlay", async () => {
    // The logs overlay implements describe-log-groups with its own projection.
    const stub = createStub({
      stdout: JSON.stringify({
        logGroups: [
          { logGroupName: "/aws/lambda/my-function", storedBytes: 1024 },
        ],
      }),
      exitCode: 0,
    });

    const { output, exitCode } = await captureMain(
      ["logs", "describe-log-groups"],
      {
        PATH: `${stubPath(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    // The overlay's describe-log-groups returns a curated groups shape
    expect(output).toContain("/aws/lambda/my-function");
    expect(exitCode).toBeUndefined();
  });

  it("filter-log-events falls through to the engine when not handled by overlay", async () => {
    // filter-log-events is NOT in the logs overlay but IS a real CloudWatch Logs op.
    // The engine requires --log-group-name (from the fixture model's required field).
    // Passing --log-group-name satisfies the engine's required-param check.
    const stub = createStub({
      stdout: JSON.stringify({
        events: [
          {
            logStreamName: "stream-1",
            timestamp: 1720692000000,
            message: "test event from engine",
          },
        ],
      }),
      exitCode: 0,
    });

    const { output, exitCode } = await captureMain(
      ["logs", "filter-log-events", "--log-group-name", "/aws/lambda/my-fn"],
      {
        PATH: `${stubPath(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    // Engine ran — should see the events data
    expect(output).toContain("test event from engine");
    // Must NOT be a USAGE_ERROR from the overlay's hardcoded allowlist
    expect(output).not.toContain("USAGE_ERROR");
    expect(exitCode).toBeUndefined();
  });

  it("a bogus op unknown to the logs model errors cleanly via the engine", async () => {
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["logs", "totally-bogus-logs-op"],
      {
        PATH: `${stubPath(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("totally-bogus-logs-op");
    expect(output).toContain("USAGE_ERROR");
    expect(exitCode).toBe(252);
  });
});
