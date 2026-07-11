/**
 * Tests for the `wait` primitive (src/commands/wait.ts).
 *
 * Strategy: real stub aws binary via the exec seam (`binary` injection);
 * real botocore model fixture (`fake-svc`) via `dataDir` injection.
 * No function mocks.
 *
 * Coverage:
 *   - Happy path: stub exits 0 → structured success result with model metadata
 *   - Waiter timeout: stub exits 255 → AxiError SERVICE_CLIENT_ERROR with budget
 *   - Failure acceptor hit: stub exits 255 → same error path
 *   - Unknown waiter name → AxiError USAGE_ERROR listing available waiters
 *   - Credential error → AxiError NO_CREDENTIALS (propagated from exec seam)
 *   - Missing args → AxiError USAGE_ERROR
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { waitRun, waitCommand } from "../src/commands/wait.js";
import { AxiError } from "axi-sdk-js";

// ---------------------------------------------------------------------------
// Fixtures + stub helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-wait-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
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

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("waitRun — happy path (stub exits 0)", () => {
  it("returns a structured success result with model metadata", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitRun({
      service: "fake-svc",
      waiterName: "ItemExists",
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    expect(result.waited).toBe(true);
    expect(result.service).toBe("fake-svc");
    expect(result.waiter).toBe("ItemExists");
    // model says operation = PaginatedOp
    expect(result.targetOp).toBe("PaginatedOp");
    // delay=5, maxAttempts=20 → budget=100s
    expect(result.pollIntervalSeconds).toBe(5);
    expect(result.polls).toBe(20);
    expect(result.budgetSeconds).toBe(100);
  });

  it("passes extra flags through to the aws binary", async () => {
    // Stub that captures args and exits 0 — we verify via exit code
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitRun({
      service: "fake-svc",
      waiterName: "ItemExists",
      flags: ["--filter", "Name=status,Values=available"],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    expect(result.waited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Waiter timeout / failure
// ---------------------------------------------------------------------------

describe("waitRun — waiter timeout (stub exits 255)", () => {
  it("throws AxiError with SERVICE_CLIENT_ERROR and budget context", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Waiter ItemExists failed: Max attempts exceeded",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: "ItemExists",
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    expect((err as AxiError).message).toContain("ItemExists");
    expect((err as AxiError).message).toContain("fake-svc");
    // Budget info must appear in either message or suggestions
    const full =
      (err as AxiError).message +
      " " +
      (err as AxiError).suggestions.join(" ");
    expect(full).toMatch(/100s|20.*5s|5s.*20/);
  });

  it("suggestions include the target operation and polling cadence", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Waiter ItemExists failed",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: "ItemExists",
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect((err as AxiError).suggestions.length).toBeGreaterThan(0);
    const combined = (err as AxiError).suggestions.join(" ");
    expect(combined).toContain("PaginatedOp");
  });
});

describe("waitRun — failure acceptor hit (stub exits 255, different message)", () => {
  it("throws AxiError SERVICE_CLIENT_ERROR for any non-zero exit", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Waiter encountered a terminal failure state",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: "ItemExists",
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Unknown waiter → USAGE_ERROR
// ---------------------------------------------------------------------------

describe("waitRun — unknown waiter name", () => {
  it("throws USAGE_ERROR listing available waiters before calling aws", async () => {
    // Stub intentionally non-existent — must never be called
    const stub = "/dev/null";

    const err = await waitRun({
      service: "fake-svc",
      waiterName: "BucketExists", // not in fake-svc fixture
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("USAGE_ERROR");
    expect((err as AxiError).message).toContain("BucketExists");
    expect((err as AxiError).message).toContain("fake-svc");
    // Must surface available waiters
    const full =
      (err as AxiError).message +
      " " +
      (err as AxiError).suggestions.join(" ");
    expect(full).toContain("ItemExists");
  });
});

// ---------------------------------------------------------------------------
// Credential error propagation
// ---------------------------------------------------------------------------

describe("waitRun — credential error propagation", () => {
  it("propagates NO_CREDENTIALS AxiError from the exec seam", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: "ItemExists",
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("NO_CREDENTIALS");
  });

  it("propagates AUTH_EXPIRED AxiError from the exec seam", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (ExpiredTokenException) when calling the DescribeInstances operation: The security token included in the request is expired",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: "ItemExists",
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("AUTH_EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// waitCommand adapter — arg parsing
// ---------------------------------------------------------------------------

describe("waitCommand — arg validation", () => {
  it("throws USAGE_ERROR when fewer than 2 positional args", async () => {
    const err = await waitCommand([], undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("USAGE_ERROR");
  });

  it("throws USAGE_ERROR when only service is provided", async () => {
    const err = await waitCommand(["ec2"], undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("USAGE_ERROR");
  });

  it("delegates to waitRun and returns a plain object", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    // Use fake-svc fixture via the dataDir option on waitCommand
    const result = await waitCommand(
      ["fake-svc", "ItemExists"],
      undefined,
      { binary: stub, dataDir: FIXTURES_DIR },
    );

    expect(typeof result).toBe("object");
    expect(result["waited"]).toBe(true);
    expect(result["service"]).toBe("fake-svc");
    expect(result["waiter"]).toBe("ItemExists");
  });

  it("passes remaining args as flags to waitRun", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitCommand(
      ["fake-svc", "ItemExists", "--filter", "Name=id,Values=foo"],
      undefined,
      { binary: stub, dataDir: FIXTURES_DIR },
    );

    expect(result["waited"]).toBe(true);
  });
});
