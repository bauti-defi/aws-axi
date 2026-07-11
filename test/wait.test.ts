/**
 * Tests for the `wait` primitive (src/commands/wait.ts).
 *
 * Strategy: real stub aws binary via the exec seam (`binary` injection);
 * real botocore model fixture (`fake-svc`) via `dataDir` injection.
 * No function mocks.
 *
 * Fixture waiter: `ItemReady` (PascalCase key in waiters-2.json).
 * User-facing form: `item-ready` (kebab — matches the AWS CLI convention).
 * This gap exercises the kebab→PascalCase reverse-map lookup on every test.
 *
 * Coverage:
 *   - Kebab → PascalCase model lookup (the core regression guard)
 *   - Happy path: stub exits 0 → structured success result with model metadata
 *   - Waiter timeout: stub exits 255 + "Max attempts exceeded" → budget message
 *   - Terminal failure: stub exits 255 + "terminal failure state" → failure message (no retry)
 *   - Unknown waiter name → USAGE_ERROR listing available waiters in kebab-case
 *   - Kebab-cased available-waiters list
 *   - Credential error → AxiError NO_CREDENTIALS (propagated from exec seam)
 *   - AUTH_EXPIRED propagation
 *   - Missing args → AxiError USAGE_ERROR
 *   - waitCommand adapter: arg parsing, delegation, flag pass-through
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

// The fixture waiter as the user types it (kebab). The botocore key is ItemReady.
const WAITER_KEBAB = "item-ready";

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
// Kebab → PascalCase reverse-map lookup (the core regression guard)
// ---------------------------------------------------------------------------

describe("waitRun — kebab input resolves against PascalCase botocore model", () => {
  it("accepts kebab-case waiter name and finds the PascalCase model entry", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    // item-ready (user types) → ItemReady (botocore key) — different casing
    const result = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB, // "item-ready"
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    // Must resolve metadata from the ItemReady botocore entry
    expect(result.targetOp).toBe("PaginatedOp");
    expect(result.pollIntervalSeconds).toBe(5);
    expect(result.polls).toBe(20);
    expect(result.budgetSeconds).toBe(100);
  });

  it("result.waiter echoes the user-facing kebab form, not PascalCase", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    // Agents re-invoke using the CLI form — must be kebab
    expect(result.waiter).toBe(WAITER_KEBAB);
    expect(result.waiter).not.toMatch(/[A-Z]/); // no uppercase in returned waiter name
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("waitRun — happy path (stub exits 0)", () => {
  it("returns a structured success result with model metadata", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    expect(result.waited).toBe(true);
    expect(result.service).toBe("fake-svc");
    expect(result.waiter).toBe(WAITER_KEBAB);
    expect(result.targetOp).toBe("PaginatedOp");
    expect(result.pollIntervalSeconds).toBe(5);
    expect(result.polls).toBe(20);
    expect(result.budgetSeconds).toBe(100);
  });

  it("passes extra flags through to the aws binary", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: ["--filter", "Name=status,Values=available"],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    expect(result.waited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Waiter timeout (max attempts exhausted)
// ---------------------------------------------------------------------------

describe("waitRun — waiter timeout (stub exits 255, Max attempts exceeded)", () => {
  it("throws SERVICE_CLIENT_ERROR with budget context in message", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Waiter ItemReady failed: Max attempts exceeded",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    // Must reference the waiter in user-friendly kebab terms
    expect((err as AxiError).message).toContain(WAITER_KEBAB);
    expect((err as AxiError).message).toContain("fake-svc");
    // Budget context (100s = 20 polls × 5s)
    const full =
      (err as AxiError).message + " " + (err as AxiError).suggestions.join(" ");
    expect(full).toMatch(/100s|20[^0-9]+5s|5s[^0-9]+20/);
  });

  it("timeout suggestions include retry advice", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Waiter ItemReady failed: Max attempts exceeded",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    const combined = (err as AxiError).suggestions.join(" ").toLowerCase();
    expect(combined).toMatch(/retry|transitioning/);
  });

  it("timeout suggestions include the target operation", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Waiter ItemReady failed: Max attempts exceeded",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    const combined = (err as AxiError).suggestions.join(" ");
    expect(combined).toContain("PaginatedOp");
  });
});

// ---------------------------------------------------------------------------
// Terminal failure acceptor hit (distinct from timeout)
// ---------------------------------------------------------------------------

describe("waitRun — terminal failure acceptor (stub exits 255, terminal failure state)", () => {
  it("throws SERVICE_CLIENT_ERROR with failure-state message", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "Waiter ItemReady failed: Waiter encountered a terminal failure state: ItemReady",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    // Must clearly indicate a failure state was reached, not a timeout
    expect((err as AxiError).message.toLowerCase()).toMatch(
      /failure state|terminal/,
    );
  });

  it("terminal failure suggestions do NOT advise retry (agent could loop forever)", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "Waiter ItemReady failed: Waiter encountered a terminal failure state: deleted",
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    const combined = (err as AxiError).suggestions.join(" ").toLowerCase();
    // Must NOT contain "retry" for terminal failures
    expect(combined).not.toMatch(/\bretry\b/);
  });

  it("terminal failure preserves / surfaces the botocore stderr", async () => {
    const botocoreMsg =
      "Waiter ItemReady failed: Waiter encountered a terminal failure state: deleted";
    const stub = createStub({
      stdout: "",
      stderr: botocoreMsg,
      exitCode: 255,
    });

    const err = await waitRun({
      service: "fake-svc",
      waiterName: WAITER_KEBAB,
      flags: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    // The botocore message must appear somewhere (message or suggestions)
    const full =
      (err as AxiError).message + " " + (err as AxiError).suggestions.join(" ");
    expect(full).toContain(botocoreMsg);
  });
});

// ---------------------------------------------------------------------------
// Unknown waiter → USAGE_ERROR with kebab-case available list
// ---------------------------------------------------------------------------

describe("waitRun — unknown waiter name", () => {
  it("throws USAGE_ERROR before calling aws when waiter is not in the model", async () => {
    const err = await waitRun({
      service: "fake-svc",
      waiterName: "item-exists", // old name — not in fixture
      flags: [],
      binary: "/dev/null", // must never be called
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("USAGE_ERROR");
    expect((err as AxiError).message).toContain("item-exists");
    expect((err as AxiError).message).toContain("fake-svc");
  });

  it("USAGE_ERROR lists available waiters in kebab-case (not PascalCase)", async () => {
    const err = await waitRun({
      service: "fake-svc",
      waiterName: "no-such-waiter",
      flags: [],
      binary: "/dev/null",
      dataDir: FIXTURES_DIR,
    }).catch((e: unknown) => e);

    // Available waiters must be listed in kebab-case — agents can copy-paste them
    const full =
      (err as AxiError).message + " " + (err as AxiError).suggestions.join(" ");
    expect(full).toContain("item-ready"); // kebab form of ItemReady
    expect(full).not.toContain("ItemReady"); // must NOT expose raw PascalCase
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
      waiterName: WAITER_KEBAB,
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
      waiterName: WAITER_KEBAB,
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
  it("throws USAGE_ERROR when no args provided", async () => {
    const err = await waitCommand([], undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("USAGE_ERROR");
  });

  it("throws USAGE_ERROR when only service is provided", async () => {
    const err = await waitCommand(["ec2"], undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("USAGE_ERROR");
  });

  it("delegates to waitRun and returns a plain object with kebab waiter name", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitCommand(
      ["fake-svc", WAITER_KEBAB],
      undefined,
      { binary: stub, dataDir: FIXTURES_DIR },
    );

    expect(typeof result).toBe("object");
    expect(result["waited"]).toBe(true);
    expect(result["service"]).toBe("fake-svc");
    expect(result["waiter"]).toBe(WAITER_KEBAB); // kebab, not PascalCase
    expect(result["targetOp"]).toBe("PaginatedOp");
  });

  it("passes remaining args as flags to waitRun", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await waitCommand(
      ["fake-svc", WAITER_KEBAB, "--filter", "Name=id,Values=foo"],
      undefined,
      { binary: stub, dataDir: FIXTURES_DIR },
    );

    expect(result["waited"]).toBe(true);
  });
});
