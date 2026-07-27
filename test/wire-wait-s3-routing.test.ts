/**
 * Wire harness: PATH-shim `aws` + real waitRun entrypoint.
 *
 * Proves that `wait s3 bucket-exists` shells `aws s3api wait bucket-exists`
 * (NOT `aws s3 wait ...`), and that unaliased services (e.g. `fake-svc`)
 * are forwarded unchanged.
 *
 * Background (#76): S3 waiters live in the botocore model under `s3/` but the
 * AWS CLI exposes them under `s3api wait`, not `s3 wait`. `aws s3 wait` is
 * an invalid command and exits with a USAGE_ERROR before credentials are
 * consulted. The fix derives an inverse map from `SERVICE_ALIASES` (engine.ts)
 * so the child process receives the correct CLI service name.
 *
 * Audit scope: `codedeploy` has the same shape — botocore model name is
 * `codedeploy` but the CLI command is `deploy`. The inverse map covers it too.
 * `config` (aliased from `configservice`) has NO waiters in botocore so it
 * needs no remap.
 *
 * Architecture:
 *   - A PATH-shim `aws` script writes every argv token (one per line) to a
 *     temp file, then exits 0.  Assertions are on the LITERAL ARGV reaching
 *     the child process.
 *   - `waitRun(options)` drives the real entrypoint through the full path:
 *     model load → remap → shell.
 *
 * Harness liveness guard:
 *   Each describe block anchors with a "stub IS invoked" assertion: the argv
 *   log file must exist and contain at least one token. A dead binary leaves
 *   the log absent → liveness assertion fails.
 *
 * Mutation evidence (in PR body):
 *   Axis 1 (value): change remap target s3api → s3_wrong → RED
 *   Axis 2 (wiring): remove the remap call site → RED
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { waitRun } from "../src/commands/wait.js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

/**
 * Create a PATH-shim `aws` binary that logs every argv token (one per line)
 * to `logFile`, then exits 0.
 *
 * Liveness guarantee: the script ALWAYS writes at least one token on invocation.
 * If the log is absent after the call, the binary was never invoked (harness dead).
 */
function createArgvLoggingStub(logFile: string): string {
  return stubBin(`#!/bin/sh\nprintf '%s\\n' "$@" > ${logFile}\nexit 0\n`);
}

/** Read logged argv tokens from the file written by the stub. */
function readArgv(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// s3 → s3api wait routing
// ---------------------------------------------------------------------------

describe("wire: wait s3 — shells aws s3api wait (not aws s3 wait)", () => {
  /**
   * Liveness anchor: stub must be invoked and log file written.
   * If this test fails, the harness is dead and all following results are void.
   */
  it("anchor: stub IS invoked when wait s3 bucket-exists is called", async () => {
    const logFile = join(tmpdir(), `wait-s3-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "s3",
      waiterName: "bucket-exists",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // harness is alive
  });

  /**
   * PRIMARY FIX: the first argv token (the service name) reaching the child
   * must be `s3api`, NOT `s3`.
   *
   * Pre-fix: `aws s3 wait bucket-exists` → invalid choice → USAGE_ERROR / 252.
   * Post-fix: `aws s3api wait bucket-exists` → valid command ✅
   */
  it("wait s3 bucket-exists: child process receives s3api as the service arg", async () => {
    const logFile = join(tmpdir(), `wait-s3-to-s3api-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "s3",
      waiterName: "bucket-exists",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness

    // The child must receive "s3api" as the service (argv[0]).
    expect(argv[0]).toBe("s3api");

    // The child must NOT receive the uncorrected "s3".
    expect(argv).not.toContain("s3");
  });

  /**
   * The `wait` verb and the waiter name must be forwarded unchanged.
   *
   * Regression guard: remap must not accidentally swallow or displace the
   * `wait` verb or the kebab waiter name.
   */
  it("wait s3 bucket-exists: 'wait' verb and 'bucket-exists' are forwarded", async () => {
    const logFile = join(tmpdir(), `wait-s3-verb-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "s3",
      waiterName: "bucket-exists",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv).toContain("wait");
    expect(argv).toContain("bucket-exists");
  });

  /**
   * Pass-through flags must survive the remap untouched.
   */
  it("wait s3 bucket-exists --bucket my-bucket: --bucket flag forwarded", async () => {
    const logFile = join(tmpdir(), `wait-s3-flags-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "s3",
      waiterName: "bucket-exists",
      flags: ["--bucket", "my-bucket"],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv[0]).toBe("s3api");
    expect(argv).toContain("--bucket");
    expect(argv).toContain("my-bucket");
  });

  /**
   * Other s3 waiters: bucket-not-exists, object-exists, object-not-exists.
   * Verifies the remap applies to ALL s3 waiters, not just bucket-exists.
   */
  it("wait s3 bucket-not-exists: child process receives s3api", async () => {
    const logFile = join(tmpdir(), `wait-s3-bne-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "s3",
      waiterName: "bucket-not-exists",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv[0]).toBe("s3api");
    expect(argv).toContain("bucket-not-exists");
    expect(argv).not.toContain("s3");
  });

  it("wait s3 object-exists: child process receives s3api", async () => {
    const logFile = join(tmpdir(), `wait-s3-oe-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "s3",
      waiterName: "object-exists",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv[0]).toBe("s3api");
    expect(argv).toContain("object-exists");
  });

  it("wait s3 object-not-exists: child process receives s3api", async () => {
    const logFile = join(tmpdir(), `wait-s3-one-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "s3",
      waiterName: "object-not-exists",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv[0]).toBe("s3api");
    expect(argv).toContain("object-not-exists");
  });

  /**
   * The structured result must still report `service: "s3"` (user-facing), not
   * `service: "s3api"` (the internal wire name). The remap is transparent.
   */
  it("wait s3 bucket-exists: result.service is still 's3' (user-facing unchanged)", async () => {
    const logFile = join(tmpdir(), `wait-s3-result-svc-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    const result = await waitRun({
      service: "s3",
      waiterName: "bucket-exists",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    // User-facing result must reflect what the user typed, not the wire name.
    expect(result.service).toBe("s3");
    expect(result.waiter).toBe("bucket-exists");
  });
});

// ---------------------------------------------------------------------------
// Unaliased services: forward unchanged
// ---------------------------------------------------------------------------

describe("wire: wait <non-aliased-svc> — service name forwarded unchanged", () => {
  /**
   * Liveness anchor.
   */
  it("anchor: stub IS invoked for wait fake-svc item-ready", async () => {
    const logFile = join(tmpdir(), `wait-fakesvc-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "fake-svc",
      waiterName: "item-ready",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
  });

  /**
   * Non-aliased services must pass through unmodified.
   * `fake-svc` is not in SERVICE_ALIASES → child receives "fake-svc" verbatim.
   */
  it("wait fake-svc item-ready: child receives fake-svc unchanged", async () => {
    const logFile = join(tmpdir(), `wait-fakesvc-unchanged-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "fake-svc",
      waiterName: "item-ready",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv[0]).toBe("fake-svc");
    expect(argv).toContain("wait");
    expect(argv).toContain("item-ready");
  });
});

// ---------------------------------------------------------------------------
// codedeploy → deploy audit: same shape as s3/s3api
// ---------------------------------------------------------------------------

describe("wire: wait codedeploy — shells aws deploy wait (not aws codedeploy wait)", () => {
  /**
   * Liveness anchor for codedeploy.
   */
  it("anchor: stub IS invoked when wait codedeploy deployment-successful is called", async () => {
    const logFile = join(tmpdir(), `wait-codedeploy-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "codedeploy",
      waiterName: "deployment-successful",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // harness is alive
  });

  /**
   * Audit: codedeploy (botocore model name) must shell as `deploy` (CLI name).
   *
   * `aws codedeploy wait` → "Found invalid choice 'codedeploy'" (real CLI).
   * `aws deploy wait deployment-successful` → valid command ✅
   *
   * The inverse-of-SERVICE_ALIASES map covers this alongside s3.
   */
  it("wait codedeploy deployment-successful: child receives deploy (not codedeploy)", async () => {
    const logFile = join(tmpdir(), `wait-codedeploy-to-deploy-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await waitRun({
      service: "codedeploy",
      waiterName: "deployment-successful",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness

    // Child must receive "deploy" as the service name.
    expect(argv[0]).toBe("deploy");

    // Must not forward the raw botocore model name.
    expect(argv).not.toContain("codedeploy");

    expect(argv).toContain("wait");
    expect(argv).toContain("deployment-successful");
  });

  /**
   * result.service must still be "codedeploy" (what the user passed) — the remap
   * is internal only.
   */
  it("wait codedeploy: result.service is still 'codedeploy' (user-facing unchanged)", async () => {
    const logFile = join(tmpdir(), `wait-codedeploy-result-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    const result = await waitRun({
      service: "codedeploy",
      waiterName: "deployment-successful",
      flags: [],
      binary,
      dataDir: FIXTURES_DIR,
    });

    expect(result.service).toBe("codedeploy");
    expect(result.waiter).toBe("deployment-successful");
  });
});
