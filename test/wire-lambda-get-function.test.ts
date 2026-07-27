/**
 * Wire harness: PATH-shim `aws` + real CLI entrypoint.
 *
 * Proves that `lambda get-function` and `lambda get-function-configuration`
 * accept BOTH the positional form (`get-function X`) and the `--function-name`
 * flag form (`get-function --function-name X`), forwarding the function name
 * correctly in both cases.
 *
 * Architecture:
 *   - A PATH-shim `aws` script writes every argv token (one per line) to a temp
 *     file, then exits 0.  Assertions are on the LITERAL ARGV that reached the
 *     child process (index-based for positional slots, contains-based for flags).
 *   - `lambdaRun(options)` drives the real overlay through the full dispatch path.
 *
 * Harness liveness guard:
 *   Each test group anchors with a "stub IS invoked" assertion: the argv log
 *   file must exist and contain at least one token.  A dead binary (wrong path /
 *   crash) leaves the log absent → liveness assertion fails, harness is clearly
 *   dead.
 *
 * Non-vacuous conflict/malformed error assertions:
 *   When a call must USAGE_ERROR BEFORE reaching the child, we assert:
 *     (a) The thrown error code is "USAGE_ERROR"
 *     (b) The error message contains the OVERLAY's distinguishing text
 *         (e.g. "Conflicting" for the conflict case) — real `aws` never emits
 *         this exact wording, so if the guard is bypassed and `aws` returns
 *         a different error, this assertion correctly goes RED.
 *     (c) The stub log file is ABSENT (child was never invoked).
 *   This follows the #103 guidance: assert the wrapper's distinguishing output,
 *   not just `.code`, to prevent a guard regression from silently passing.
 *
 * Scope (issue #63):
 *   - `lambda get-function` — positional back-compat (regression guard)
 *   - `lambda get-function --function-name X` — new flag form
 *   - `lambda get-function-configuration` — positional back-compat
 *   - `lambda get-function-configuration --function-name X` — new flag form
 *   - Conflict: both positional AND --function-name → USAGE_ERROR (overlay text)
 *   - Missing: neither form → USAGE_ERROR
 *   - Malformed two-arg: --function-name --other-flag → USAGE_ERROR (locateLastFlag)
 *   - Passthrough: unknown flag forwarded alongside --function-name
 *   - Equals form: --function-name=my-function works
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lambdaRun } from "../src/commands/lambda.js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

/**
 * Minimal valid JSON that satisfies both RawGetFunctionResponse and
 * RawLambdaFunction (the two shapes the lambda overlay parses):
 *
 *   - RawGetFunctionResponse expects { Configuration: RawLambdaFunction }
 *   - RawLambdaFunction requires { FunctionName, FunctionArn }
 *
 * Embedding `Configuration` in the top-level JSON means the stub response
 * works for BOTH `get-function` and `get-function-configuration` without
 * branching: the overlay for each op picks the field it needs, and undefined
 * optional fields (VpcConfig, KMSKeyArn, Role, LoggingConfig) are absent so
 * enrichFunction makes no additional aws calls — the stub is invoked exactly
 * once and the argv log is stable.
 */
const STUB_LAMBDA_JSON = JSON.stringify({
  FunctionName: "stub-fn",
  FunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:stub-fn",
  Configuration: {
    FunctionName: "stub-fn",
    FunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:stub-fn",
  },
});

/**
 * Create a PATH-shim `aws` binary that:
 *   1. Logs every argv token (one per line) to `logFile`
 *   2. Prints minimal valid lambda JSON to stdout
 *   3. Exits 0
 *
 * The stub writes the "lambda" token on every invocation — if the log file is
 * absent or empty after the call, the binary was never invoked (harness dead).
 *
 * The JSON output satisfies both RawGetFunctionResponse and RawLambdaFunction
 * so the overlay's enrichFunction can proceed without error and without making
 * additional aws calls (no VpcConfig/KMSKeyArn/Role/LoggingConfig in the stub
 * response → no enrichment network calls → stub invoked exactly once).
 */
function createArgvLoggingStub(logFile: string): string {
  return stubBin(
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${logFile}\nprintf '%s' '${STUB_LAMBDA_JSON}'\nexit 0\n`,
  );
}

/** Read logged argv tokens from the file written by the stub. */
function readArgv(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Helper: assert a lambdaRun call throws AxiError USAGE_ERROR with given text
// and that the stub was NOT invoked (log absent or empty).
// ---------------------------------------------------------------------------
async function expectUsageError(
  call: () => Promise<unknown>,
  {
    containsText,
    logFile,
  }: { containsText: string; logFile: string },
): Promise<void> {
  let threw = false;
  try {
    await call();
  } catch (err: unknown) {
    threw = true;
    const e = err as { code?: string; message?: string };
    expect(e.code).toBe("USAGE_ERROR");
    // The message must contain the OVERLAY's distinguishing text — not just
    // a generic code — so a guard regression (child invoked instead) goes RED.
    expect(e.message).toContain(containsText);
  }
  expect(threw).toBe(true);
  // The stub must NOT have been invoked: the guard fired before child exec.
  const argv = readArgv(logFile);
  expect(argv.length).toBe(0);
}

// ---------------------------------------------------------------------------
// get-function — positional back-compat (regression guard)
// ---------------------------------------------------------------------------

describe("wire: lambda get-function — positional back-compat", () => {
  it("anchor: stub IS invoked for get-function <name> (liveness)", async () => {
    const logFile = join(tmpdir(), `lambda-gf-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({ subcommand: "get-function", args: ["my-function"], binary });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);                  // harness alive
    expect(argv).toContain("lambda");                         // correct service
    expect(argv).toContain("get-function");
    // The function name must appear as the value of --function-name in the argv
    // forwarded to the child (the overlay always uses the flag form with aws).
    expect(argv).toContain("my-function");
    expect(argv).toContain("--function-name");
  });

  it("get-function my-function: function name forwarded to child aws", async () => {
    const logFile = join(tmpdir(), `lambda-gf-positional-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({ subcommand: "get-function", args: ["my-function"], binary });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    // --function-name my-function must appear in the child argv.
    const fnNameIdx = argv.indexOf("--function-name");
    expect(fnNameIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fnNameIdx + 1]).toBe("my-function");
  });

  it("get-function arn:aws:lambda:us-east-1:123456:function:fn: ARN forwarded", async () => {
    const logFile = join(tmpdir(), `lambda-gf-arn-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);
    const arn = "arn:aws:lambda:us-east-1:123456789012:function:my-fn";

    await lambdaRun({ subcommand: "get-function", args: [arn], binary });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain(arn);
  });
});

// ---------------------------------------------------------------------------
// get-function — new --function-name flag form (issue #63 fix)
// ---------------------------------------------------------------------------

describe("wire: lambda get-function — --function-name flag form (issue #63)", () => {
  it("get-function --function-name my-function: function name forwarded correctly", async () => {
    const logFile = join(tmpdir(), `lambda-gf-flag-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({
      subcommand: "get-function",
      args: ["--function-name", "my-function"],
      binary,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);                  // liveness
    // The child must be invoked with the correct function name.
    const fnNameIdx = argv.indexOf("--function-name");
    expect(fnNameIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fnNameIdx + 1]).toBe("my-function");
    // "my-function" must appear exactly once (not duplicated via passthrough).
    expect(argv.filter((t) => t === "my-function").length).toBe(1);
  });

  it("get-function --function-name=my-function (equals form): forwarded correctly", async () => {
    const logFile = join(tmpdir(), `lambda-gf-flag-eq-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({
      subcommand: "get-function",
      args: ["--function-name=my-function"],
      binary,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain("my-function");
    // --function-name=my-function is expanded to two tokens in the aws call.
    const fnNameIdx = argv.indexOf("--function-name");
    expect(fnNameIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fnNameIdx + 1]).toBe("my-function");
  });

  it("get-function --function-name my-fn --qualifier v1: passthrough flag forwarded", async () => {
    const logFile = join(tmpdir(), `lambda-gf-flag-passthrough-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({
      subcommand: "get-function",
      args: ["--function-name", "my-fn", "--qualifier", "v1"],
      binary,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain("my-fn");
    // Passthrough flag must reach child.
    expect(argv).toContain("--qualifier");
    expect(argv).toContain("v1");
    // --function-name must NOT be duplicated via passthrough.
    expect(argv.filter((t) => t === "--function-name").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// get-function — conflict and missing error cases (non-vacuous)
// ---------------------------------------------------------------------------

describe("wire: lambda get-function — conflict and missing USAGE_ERROR (non-vacuous)", () => {
  it("conflict: positional + --function-name → USAGE_ERROR with 'Conflicting' text, child not invoked", async () => {
    const logFile = join(tmpdir(), `lambda-gf-conflict-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await expectUsageError(
      () =>
        lambdaRun({
          subcommand: "get-function",
          args: ["my-function", "--function-name", "other-function"],
          binary,
        }),
      { containsText: "Conflicting", logFile },
    );
  });

  it("missing: no positional and no --function-name → USAGE_ERROR, child not invoked", async () => {
    const logFile = join(tmpdir(), `lambda-gf-missing-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await expectUsageError(
      () => lambdaRun({ subcommand: "get-function", args: [], binary }),
      { containsText: "required", logFile },
    );
  });

  it("malformed two-arg: --function-name --other-flag → USAGE_ERROR (locateLastFlag), child not invoked", async () => {
    const logFile = join(tmpdir(), `lambda-gf-malformed-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await expectUsageError(
      () =>
        lambdaRun({
          subcommand: "get-function",
          args: ["--function-name", "--other-flag"],
          binary,
        }),
      { containsText: "looks like a flag", logFile },
    );
  });
});

// ---------------------------------------------------------------------------
// get-function-configuration — positional back-compat (regression guard)
// ---------------------------------------------------------------------------

describe("wire: lambda get-function-configuration — positional back-compat", () => {
  it("anchor: stub IS invoked for get-function-configuration <name> (liveness)", async () => {
    const logFile = join(tmpdir(), `lambda-gfc-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({
      subcommand: "get-function-configuration",
      args: ["my-function"],
      binary,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain("get-function-configuration");
    expect(argv).toContain("my-function");
    expect(argv).toContain("--function-name");
  });

  it("get-function-configuration my-function: function name forwarded", async () => {
    const logFile = join(tmpdir(), `lambda-gfc-positional-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({
      subcommand: "get-function-configuration",
      args: ["my-function"],
      binary,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const fnNameIdx = argv.indexOf("--function-name");
    expect(fnNameIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fnNameIdx + 1]).toBe("my-function");
  });
});

// ---------------------------------------------------------------------------
// get-function-configuration — new --function-name flag form
// ---------------------------------------------------------------------------

describe("wire: lambda get-function-configuration — --function-name flag form (issue #63)", () => {
  it("get-function-configuration --function-name my-function: forwarded correctly", async () => {
    const logFile = join(tmpdir(), `lambda-gfc-flag-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({
      subcommand: "get-function-configuration",
      args: ["--function-name", "my-function"],
      binary,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const fnNameIdx = argv.indexOf("--function-name");
    expect(fnNameIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fnNameIdx + 1]).toBe("my-function");
    // No duplication.
    expect(argv.filter((t) => t === "my-function").length).toBe(1);
  });

  it("get-function-configuration --function-name=my-fn (equals form): forwarded correctly", async () => {
    const logFile = join(tmpdir(), `lambda-gfc-flag-eq-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await lambdaRun({
      subcommand: "get-function-configuration",
      args: ["--function-name=my-fn"],
      binary,
    });

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const fnNameIdx = argv.indexOf("--function-name");
    expect(fnNameIdx).toBeGreaterThanOrEqual(0);
    expect(argv[fnNameIdx + 1]).toBe("my-fn");
  });

  it("get-function-configuration conflict: positional + --function-name → USAGE_ERROR 'Conflicting', child not invoked", async () => {
    const logFile = join(tmpdir(), `lambda-gfc-conflict-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await expectUsageError(
      () =>
        lambdaRun({
          subcommand: "get-function-configuration",
          args: ["my-function", "--function-name", "other-function"],
          binary,
        }),
      { containsText: "Conflicting", logFile },
    );
  });

  it("get-function-configuration missing: no args → USAGE_ERROR, child not invoked", async () => {
    const logFile = join(tmpdir(), `lambda-gfc-missing-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await expectUsageError(
      () =>
        lambdaRun({ subcommand: "get-function-configuration", args: [], binary }),
      { containsText: "required", logFile },
    );
  });
});
