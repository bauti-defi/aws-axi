/**
 * Wire harness: PATH-shim `aws` + real exec seams.
 *
 * Fixes #60 (sqs purge-queue) and #50 (iam put-role-policy / delete-role-policy):
 * AWS operations that return HTTP 200 with an empty body were misclassified as
 * UNKNOWN errors because `JSON.parse("")` throws.
 *
 * Root cause: `awsJson` in src/aws.ts did not distinguish "exit 0 + empty stdout"
 * (empty-body success) from "exit 0 + malformed JSON" (a genuine anomaly).
 *
 * Fix: gate on empty/whitespace-only stdout BEFORE attempting JSON.parse. When
 * stdout is empty/whitespace and the call exited 0, return `{ ok: true }` — a
 * clear acknowledged-success that renders as `ok: true` in TOON output.
 *
 * Test architecture:
 *   1. awsJson unit tests — stub exits 0 with empty stdout; assert no UNKNOWN
 *      throw and correct `{ ok: true }` return value.
 *   2. Defensive guard — non-empty but malformed JSON still → UNKNOWN.
 *   3. Safety guard — non-zero exit with empty stdout is NOT swallowed.
 *   4. engineRun integration test via fake-svc NoOutputOp — proves the engine
 *      chain (engineRun → awsJson → { ok: true }) is system-independent.
 *   5. SQS/IAM specific wire tests via real botocore models — proves the
 *      concrete ops named in the issues also return success.
 *
 * Seam verification (confirmed by code reading of src/cli.ts + src/engine.ts):
 *   sqs purge-queue        → makeEngineHandler("sqs") → engineRun → awsJson
 *   iam put-role-policy    → iamCommand → fallThroughToEngine → engineRun → awsJson
 *   iam delete-role-policy → iamCommand → fallThroughToEngine → engineRun → awsJson
 *
 * Mutation evidence (two-axis — recorded in PR body):
 *   Axis 1 (value):  flip empty-check to `result.stdout.trim() !== ""`
 *                    → tests for "empty body" scenarios go RED
 *   Axis 2 (wiring): delete the early-return branch so empty falls into JSON.parse
 *                    → same tests go RED (throws UNKNOWN instead)
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError } from "axi-sdk-js";
import { awsJson } from "../src/aws.js";
import { engineRun } from "../src/engine.js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

// ── Fixture path (for fake-svc tests) ─────────────────────────────────────────

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ── Stub factory ──────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const lines = [
    "#!/bin/sh",
    spec.stdout !== undefined ? `printf '%s' ${shellQuote(spec.stdout)}` : "",
    spec.stderr !== undefined
      ? `printf '%s' ${shellQuote(spec.stderr)} >&2`
      : "",
    `exit ${spec.exitCode ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");
  return stubBin(lines);
}

// ── 1. awsJson unit tests ──────────────────────────────────────────────────────

describe("awsJson: empty-body 200 success (fix for #60 and #50)", () => {
  /**
   * PRIMARY FIX — empty stdout, exit 0.
   *
   * Pre-fix: JSON.parse("") throws → catch block → AxiError UNKNOWN
   * Post-fix: empty stdout gated before JSON.parse → returns { ok: true }
   *
   * Covers: sqs purge-queue (#60), iam put-role-policy (#50),
   *         iam delete-role-policy (#50), and all other empty-body write ops.
   */
  it("empty stdout + exit 0: returns { ok: true } (no UNKNOWN throw)", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await awsJson(
      ["sqs", "purge-queue", "--queue-url", "https://sqs.us-east-1.amazonaws.com/123/q"],
      { binary: stub },
    );

    expect(result).toEqual({ ok: true });
  });

  /**
   * Defensive: whitespace-only stdout (trailing newline from some AWS CLI versions)
   * must also be treated as empty-body success.
   */
  it("whitespace-only stdout + exit 0: returns { ok: true }", async () => {
    const stub = createStub({ stdout: "\n", exitCode: 0 });

    const result = await awsJson(
      ["iam", "put-role-policy"],
      { binary: stub },
    );

    expect(result).toEqual({ ok: true });
  });

  /**
   * DEFENSIVE GUARD — non-empty, malformed JSON + exit 0 must still → UNKNOWN.
   *
   * The fix gates specifically on EMPTY/WHITESPACE-ONLY stdout, NOT on
   * "JSON.parse threw". A non-empty but unparseable stdout (e.g. garbled
   * response) is a real anomaly and must surface as UNKNOWN.
   *
   * Pre-fix AND post-fix: non-empty invalid JSON → UNKNOWN. If this test goes
   * RED after the fix, the fix is too broad (it swallows real anomalies).
   *
   * Mutation axis 1 proof:
   *   Flip: `result.stdout.trim() === ""` → `result.stdout.trim() !== ""`
   *   Effect: non-empty input now triggers early-return → this test goes RED
   *           (we return { ok: true } instead of throwing UNKNOWN).
   */
  it("non-empty invalid JSON + exit 0: still throws UNKNOWN (no over-broadening)", async () => {
    const stub = createStub({ stdout: "not-valid-json{{{", exitCode: 0 });

    let caught: unknown;
    try {
      await awsJson(["fake-svc", "simple-op"], { binary: stub });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AxiError);
    expect((caught as AxiError).code).toBe("UNKNOWN");
    expect((caught as AxiError).message).toContain("Unexpected aws output");
  });

  /**
   * SAFETY — non-zero exit with empty stdout must NOT be swallowed as success.
   *
   * The empty-body-success branch is gated on `result.error === undefined`
   * (exit code 0 AND no parse error). An error exit with empty stdout must
   * propagate the error, not silently return { ok: true }.
   *
   * This is the core safety constraint: we do NOT treat empty as success when
   * `result.error` is defined — i.e., when the exit code is non-zero.
   *
   * Mutation axis 2 proof:
   *   Delete the `if (result.stdout.trim() === "")` early-return entirely.
   *   Effect: the guard is gone. Tests 1 and 2 go RED (empty body throws UNKNOWN
   *   instead of returning success). This safety test stays GREEN either way —
   *   non-zero exit propagates via the `result.error` branch regardless of
   *   whether the empty-stdout guard exists.
   */
  it("empty stdout + non-zero exit: still throws AxiError (not silently success)", async () => {
    const stub = createStub({
      stdout: "",
      // AccessDenied error in botocore format (without the ": <detail>" suffix,
      // so parseAwsError classifies it as UNKNOWN — the exact code doesn't matter
      // for this safety test; what matters is that the call throws rather than
      // returning { ok: true }).
      stderr: "An error occurred (AccessDenied) when calling the PurgeQueue operation",
      exitCode: 254,
    });

    let caught: unknown;
    try {
      await awsJson(
        ["sqs", "purge-queue", "--queue-url", "https://sqs.us-east-1.amazonaws.com/123/q"],
        { binary: stub, configPath: "/nonexistent/.aws/config" },
      );
    } catch (e) {
      caught = e;
    }

    // Must throw — never silently return success for a non-zero exit.
    expect(caught).toBeInstanceOf(AxiError);
    // The message must NOT be the empty-body success message — it's an error.
    expect((caught as AxiError).message).not.toContain("ok");
  });
});

// ── 2. engineRun integration: fake-svc NoOutputOp ─────────────────────────────

describe("engineRun: no-output-op via fake-svc fixture returns { ok: true }", () => {
  /**
   * Proves the full engine → awsJson chain without real AWS credentials or
   * real SQS/IAM botocore models.
   *
   * NoOutputOp in fake-svc has no input shape (no required params) and no
   * output shape — models write-only operations like purge-queue,
   * put-role-policy, delete-role-policy, etc. that return empty-body 200.
   *
   * Liveness anchor: if engineRun throws BEFORE calling the binary (e.g. a
   * USAGE_ERROR from botocore validation), the stub never runs and the test
   * would fail loudly — proving the binary IS being invoked.
   */
  it("anchor + fix: empty-body stub → engineRun returns { ok: true }", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await engineRun({
      service: "fake-svc",
      operation: "no-output-op",
      args: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    // The engine strips ResponseMetadata (absent here) and passes { ok: true }
    // through from awsJson. This is the user-visible result.
    expect(result).toEqual({ ok: true });
  });

  /**
   * Regression guard: normal JSON response through the same engine path works.
   *
   * Ensures the empty-body fix doesn't break operations that return real JSON.
   * A bug in the guard (e.g. treating ALL responses as empty) would surface here.
   */
  it("normal JSON response through engineRun still works (regression guard)", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ Value: "hello" }),
      exitCode: 0,
    });

    const result = await engineRun({
      service: "fake-svc",
      operation: "simple-op",
      args: [],
      binary: stub,
      dataDir: FIXTURES_DIR,
    });

    expect(result).toMatchObject({ Value: "hello" });
  });
});

// ── 3. SQS/IAM specific wire tests via real botocore models ────────────────────
//
// These tests call engineRun with the real installed AWS CLI botocore models
// (auto-discovered from `which aws` — same as no-region-e2e.test.ts) and a stub
// binary that returns empty stdout + exit 0.
//
// They prove the specific ops named in the issues (#60 / #50) complete
// without UNKNOWN — tracing the full path from CLI seam to `awsJson`.
//
// Requirement: AWS CLI installed (same requirement as no-region-e2e.test.ts).

describe("wire: sqs purge-queue — empty-body 200 success (#60)", () => {
  /**
   * PurgeQueue requires --queue-url (from real SQS botocore model).
   * Providing it ensures the engine passes botocore validation and calls
   * the stub binary — which is the liveness proof.
   */
  it("anchor + fix: purge-queue with empty-body stub returns { ok: true }", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await engineRun({
      service: "sqs",
      operation: "purge-queue",
      args: ["--queue-url", "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue"],
      binary: stub,
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("wire: iam put-role-policy — empty-body 200 success (#50)", () => {
  /**
   * PutRolePolicy requires --role-name, --policy-name, --policy-document
   * (from real IAM botocore model).
   */
  it("anchor + fix: put-role-policy with empty-body stub returns { ok: true }", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await engineRun({
      service: "iam",
      operation: "put-role-policy",
      args: [
        "--role-name", "test-role",
        "--policy-name", "test-policy",
        "--policy-document", '{"Version":"2012-10-17","Statement":[]}',
      ],
      binary: stub,
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("wire: iam delete-role-policy — empty-body 200 success (#50)", () => {
  /**
   * DeleteRolePolicy requires --role-name, --policy-name
   * (from real IAM botocore model).
   */
  it("anchor + fix: delete-role-policy with empty-body stub returns { ok: true }", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });

    const result = await engineRun({
      service: "iam",
      operation: "delete-role-policy",
      args: [
        "--role-name", "test-role",
        "--policy-name", "test-policy",
      ],
      binary: stub,
    });

    expect(result).toEqual({ ok: true });
  });
});
