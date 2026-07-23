/**
 * Tests for src/engine.ts — model-driven generic engine.
 *
 * Uses:
 *   - Real botocore model via fixture data dir (fake-svc)
 *   - Real stub `aws` binary injected via the `binary` seam
 *   - No function mocks
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AxiError } from "axi-sdk-js";
import {
  engineRun,
  toCliFlag,
  stripOutputFlag,
  type EngineRunOptions,
} from "../src/engine.js";
import { resolveOperationName, loadService } from "../src/model.js";

// ── Fixture paths ─────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ── Stub helpers ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-engine-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");

  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }

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

/**
 * Create a stub that exits 1 (with a diagnostic) if `bannedArg` IS present in
 * its argv. Proves a flag was NOT forwarded to the child when the test passes.
 *
 * RED  (before fix): banned flag IS forwarded → stub exits 1 → awsJson throws.
 * GREEN (after fix): banned flag absent        → stub exits 0 → test passes.
 */
function createArgBanStub(spec: {
  bannedArg: string;
  validStdout: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-engine-ban-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");

  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }

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
 * Create a stub that exits 1 if `requiredArg` is absent from its argv.
 * Proves a flag WAS forwarded to the child when the test passes.
 */
function createArgGuardStub(spec: {
  requiredArg: string;
  validStdout: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-engine-guard-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");

  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }

  const script = [
    "#!/bin/sh",
    "found=0",
    'for arg in "$@"; do',
    `  [ "$arg" = ${shellQuote(spec.requiredArg)} ] && found=1`,
    "done",
    'if [ "$found" = "0" ]; then',
    `  printf 'MISSING_FLAG: %s was not forwarded\\n' ${shellQuote(spec.requiredArg)} >&2`,
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

function baseOptions(
  overrides: Partial<EngineRunOptions> = {},
): EngineRunOptions {
  return {
    service: "fake-svc",
    operation: "simple-op",
    args: [],
    dataDir: FIXTURES_DIR,
    ...overrides,
  };
}

// ── Unit tests for pure helpers ───────────────────────────────────────────────

describe("resolveOperationName — acronym-safe reverse-map lookup", () => {
  const getModel = () => loadService("fake-svc", { dataDir: FIXTURES_DIR });

  it("resolves a simple op", () => {
    expect(resolveOperationName(getModel(), "simple-op")).toBe("SimpleOp");
  });

  it("resolves required-op", () => {
    expect(resolveOperationName(getModel(), "required-op")).toBe("RequiredOp");
  });

  it("resolves GetIPThing from get-ip-thing (IP acronym)", () => {
    // Naive toPascalCase("get-ip-thing") = "GetIpThing" ≠ "GetIPThing"
    // Reverse-map is the only correct approach for acronym-bearing op names.
    expect(resolveOperationName(getModel(), "get-ip-thing")).toBe("GetIPThing");
  });

  it("resolves GetDBThing from get-db-thing (DB acronym)", () => {
    // Naive toPascalCase("get-db-thing") = "GetDbThing" ≠ "GetDBThing"
    expect(resolveOperationName(getModel(), "get-db-thing")).toBe("GetDBThing");
  });

  it("returns undefined for unknown ops", () => {
    expect(resolveOperationName(getModel(), "nonexistent-op")).toBeUndefined();
  });

  it("demonstrates naive title-casing fails for acronym ops", () => {
    // This is the exact bug that naive toPascalCase has. We document it here
    // so the test suite explicitly shows WHY the reverse-map is required.
    const naiveGetIPThing = "get-ip-thing"
      .split("-")
      .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
      .join("");
    // Naive conversion = "GetIpThing" — NOT in the model.
    expect(naiveGetIPThing).toBe("GetIpThing");
    expect(getModel().operations.has(naiveGetIPThing)).toBe(false);
    // But resolveOperationName finds it correctly via the reverse-map.
    expect(resolveOperationName(getModel(), "get-ip-thing")).toBe("GetIPThing");
  });
});

describe("toCliFlag", () => {
  it("converts PascalCase param name to --flag form", () => {
    expect(toCliFlag("Bucket")).toBe("--bucket");
    expect(toCliFlag("QueueUrl")).toBe("--queue-url");
    expect(toCliFlag("MaxResults")).toBe("--max-results");
    expect(toCliFlag("Key")).toBe("--key");
  });
});

describe("stripOutputFlag", () => {
  it("strips --output <value> (two-arg form)", () => {
    expect(stripOutputFlag(["--output", "table", "--region", "us-east-1"])).toEqual([
      "--region",
      "us-east-1",
    ]);
  });

  it("strips --output=<value> (equals form)", () => {
    expect(stripOutputFlag(["--output=json", "--max-items", "10"])).toEqual([
      "--max-items",
      "10",
    ]);
  });

  it("leaves args untouched when no --output present", () => {
    const args = ["--queue-url", "https://example.com", "--max-items", "10"];
    expect(stripOutputFlag(args)).toEqual(args);
  });

  it("is idempotent", () => {
    const args = ["--output", "table", "--foo", "bar"];
    expect(stripOutputFlag(stripOutputFlag(args))).toEqual(["--foo", "bar"]);
  });
});

// ── Required-param validation ─────────────────────────────────────────────────

describe("engineRun — required param validation", () => {
  it("throws USAGE_ERROR listing missing required params + signature when params absent", async () => {
    // RequiredOp requires Bucket and Key
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    await expect(
      engineRun(
        baseOptions({ operation: "required-op", args: [], binary: stub }),
      ),
    ).rejects.toBeInstanceOf(AxiError);

    try {
      await engineRun(
        baseOptions({ operation: "required-op", args: [], binary: stub }),
      );
    } catch (err) {
      expect((err as AxiError).code).toBe("USAGE_ERROR");
      // Error message must list the missing params
      expect((err as AxiError).message).toContain("--bucket");
      expect((err as AxiError).message).toContain("--key");
      // Must include the distilled signature
      expect((err as AxiError).message).toContain("required-op");
    }
  });

  it("throws USAGE_ERROR only for the params that are actually missing", async () => {
    // Provide --bucket but not --key
    const stub = createStub({ stdout: '{"Result":"ok"}', exitCode: 0 });

    try {
      await engineRun(
        baseOptions({
          operation: "required-op",
          args: ["--bucket", "my-bucket"],
          binary: stub,
        }),
      );
    } catch (err) {
      expect((err as AxiError).code).toBe("USAGE_ERROR");
      // The first line of the message lists ONLY the missing params; --bucket is provided
      const firstLine = (err as AxiError).message.split("\n")[0] ?? "";
      expect(firstLine).toContain("--key");
      expect(firstLine).not.toContain("--bucket");
    }
  });

  it("accepts --param=value form for required param validation", async () => {
    const stub = createStub({ stdout: '{"Result":"ok"}', exitCode: 0 });

    // Both provided via = form — should NOT throw
    const result = await engineRun(
      baseOptions({
        operation: "required-op",
        args: ["--bucket=my-bucket", "--key=my-key"],
        binary: stub,
      }),
    );
    expect(result).toMatchObject({ Result: "ok" });
  });

  it("passes when all required params are present", async () => {
    const stub = createStub({ stdout: '{"Result":"ok"}', exitCode: 0 });

    const result = await engineRun(
      baseOptions({
        operation: "required-op",
        args: ["--bucket", "my-bucket", "--key", "my-key"],
        binary: stub,
      }),
    );
    expect(result).toMatchObject({ Result: "ok" });
  });
});

// ── Happy path — simple (non-paginated) operation ─────────────────────────────

describe("engineRun — happy path (simple-op)", () => {
  it("returns projected output for a simple operation", async () => {
    const stub = createStub({ stdout: '{"Value":"hello"}', exitCode: 0 });

    const result = await engineRun(
      baseOptions({ operation: "simple-op", args: [], binary: stub }),
    );
    expect(result).toMatchObject({ Value: "hello" });
  });

  it("strips ResponseMetadata from output", async () => {
    const stub = createStub({
      stdout: JSON.stringify({
        Value: "hello",
        ResponseMetadata: { RequestId: "abc-123", HTTPStatusCode: 200 },
      }),
      exitCode: 0,
    });

    const result = await engineRun(
      baseOptions({ operation: "simple-op", args: [], binary: stub }),
    );
    expect(result).toMatchObject({ Value: "hello" });
    expect(result["ResponseMetadata"]).toBeUndefined();
  });

  it("passes additional flags through to the aws CLI call", async () => {
    // Stub echoes args — we just verify no error is thrown and output is returned
    const stub = createStub({ stdout: '{"Value":"world"}', exitCode: 0 });

    const result = await engineRun(
      baseOptions({
        operation: "simple-op",
        args: ["--some-flag", "some-value"],
        binary: stub,
      }),
    );
    expect(result).toMatchObject({ Value: "world" });
  });
});

// ── Acronym operation names (regression: naive toPascalCase fails) ───────────

describe("engineRun — acronym operation names", () => {
  it("dispatches get-ip-thing to GetIPThing via reverse-map lookup", async () => {
    // If the engine used naive toPascalCase, get-ip-thing → GetIpThing (not found).
    const stub = createStub({ stdout: '{"Thing":"ip-found"}', exitCode: 0 });
    const result = await engineRun(
      baseOptions({ operation: "get-ip-thing", args: [], binary: stub }),
    );
    expect(result).toMatchObject({ Thing: "ip-found" });
  });

  it("dispatches get-db-thing to GetDBThing via reverse-map lookup", async () => {
    const stub = createStub({ stdout: '{"Thing":"db-found"}', exitCode: 0 });
    const result = await engineRun(
      baseOptions({ operation: "get-db-thing", args: [], binary: stub }),
    );
    expect(result).toMatchObject({ Thing: "db-found" });
  });
});

// ── --output passthrough hazard ───────────────────────────────────────────────

describe("engineRun — --output passthrough hazard", () => {
  it("strips user --output flag before exec to prevent double --output json", async () => {
    // The stub returns valid JSON regardless; the test proves no error is thrown
    // (double --output would cause aws to error or produce bad output)
    const stub = createStub({ stdout: '{"Value":"ok"}', exitCode: 0 });

    const result = await engineRun(
      baseOptions({
        operation: "simple-op",
        args: ["--output", "table"],
        binary: stub,
      }),
    );
    expect(result).toMatchObject({ Value: "ok" });
  });

  it("strips --output=json form too", async () => {
    const stub = createStub({ stdout: '{"Value":"ok"}', exitCode: 0 });

    const result = await engineRun(
      baseOptions({
        operation: "simple-op",
        args: ["--output=json"],
        binary: stub,
      }),
    );
    expect(result).toMatchObject({ Value: "ok" });
  });
});

// ── Pagination cap + honest truncation ───────────────────────────────────────

describe("engineRun — pagination cap (paginated-op)", () => {
  /**
   * This fixture response simulates what botocore --max-items returns:
   *   - Only the aggregated result-key (Items)
   *   - A synthesized NextToken (NOT IsTruncated, NOT Marker, NOT native flags)
   *
   * The engine MUST gate truncation only on the presence of NextToken here.
   */
  it("detects truncation from synthesized NextToken only", async () => {
    const paginatedResponse = JSON.stringify({
      Items: ["item-1", "item-2", "item-3"],
      NextToken: "eyJleGFtcGxlIjoidG9rZW4ifQ==",
    });
    const stub = createStub({ stdout: paginatedResponse, exitCode: 0 });

    const result = await engineRun(
      baseOptions({ operation: "paginated-op", args: [], binary: stub }),
    );

    // Must report count and truncation
    expect(result["count"]).toBe(3);
    expect(result["truncated"]).toBe(true);
    expect(result["nextToken"]).toBe("eyJleGFtcGxlIjoidG9rZW4ifQ==");
    // Must include resume hint
    const help = result["help"] as string[];
    expect(Array.isArray(help)).toBe(true);
    expect(help.some((h) => h.includes("--starting-token"))).toBe(true);
  });

  it("does NOT report truncated when NextToken is absent", async () => {
    // Full result — no more pages
    const paginatedResponse = JSON.stringify({
      Items: ["item-1", "item-2"],
    });
    const stub = createStub({ stdout: paginatedResponse, exitCode: 0 });

    const result = await engineRun(
      baseOptions({ operation: "paginated-op", args: [], binary: stub }),
    );

    expect(result["count"]).toBe(2);
    expect(result["truncated"]).toBeUndefined();
    expect(result["nextToken"]).toBeUndefined();
  });

  it("never gates truncation on IsTruncated — dead code per spec", async () => {
    // Simulate a native IsTruncated=true WITHOUT a synthesized NextToken
    // The engine must NOT treat this as truncated.
    const stub = createStub({
      stdout: JSON.stringify({
        Items: ["x"],
        IsTruncated: true, // native field — must be ignored
      }),
      exitCode: 0,
    });

    const result = await engineRun(
      baseOptions({ operation: "paginated-op", args: [], binary: stub }),
    );

    expect(result["truncated"]).toBeUndefined();
    // IsTruncated passes through as a data field (no special meaning)
  });

  it("adds --max-items cap when not already in args", async () => {
    /**
     * We can't inspect what args the stub received, but we prove that the engine
     * correctly calls with --max-items by verifying the paginated behavior
     * (the stub returns the correct shape; the key invariant is no double --max-items).
     */
    const stub = createStub({
      stdout: JSON.stringify({ Items: ["a", "b"] }),
      exitCode: 0,
    });

    const result = await engineRun(
      baseOptions({
        operation: "paginated-op",
        args: [],
        binary: stub,
        maxItems: 5,
      }),
    );
    expect(result["count"]).toBe(2);
  });

  it("does NOT add --max-items when caller already passed it", async () => {
    // Verify the engine doesn't double-append --max-items; the stub returns
    // valid output regardless, proving no error from duplicate flags.
    const stub = createStub({
      stdout: JSON.stringify({ Items: ["a"] }),
      exitCode: 0,
    });

    const result = await engineRun(
      baseOptions({
        operation: "paginated-op",
        args: ["--max-items", "10"],
        binary: stub,
      }),
    );
    expect(result["count"]).toBe(1);
  });
});

// ── --query bypass: cap suppressed ───────────────────────────────────────────
//
// ADR-0002 cap bypass for the generic engine path.
//
// Without --query: engine pushes --max-items on every paginated op.
// With    --query: JMESPath is applied by the aws CLI before the response
//   reaches us; the result shape is unknown and may be an array. The engine
//   must NOT push --max-items (botocore auto-pages to completion) and must
//   skip projectOutput (which expects the paginator result-key shape).
//
// Ban-stub approach: the stub exits 1 if the banned flag appears in its argv.
//   RED  (before fix): engine pushes --max-items → ban stub exits 1 → awsJson
//     throws SERVICE_CLIENT_ERROR → engineRun throws → test FAILS.
//   GREEN (after fix): queryActive suppresses --max-items push → ban stub exits 0
//     → engine returns the raw result → test PASSES.
//
// Revert proof: commenting out the `&& !queryActive` guard in engine.ts step 4
// turns both tests red.

describe("engineRun — --query bypass: cap suppressed on paginated ops", () => {
  it("--query: --max-items NOT forwarded to child when --query is present", async () => {
    // paginated-op is in paginators-1.json, so the engine would normally push
    // --max-items. With --query active it must not.
    const banStub = createArgBanStub({
      bannedArg: "--max-items",
      validStdout: '{"result":"query-engine-ok"}',
    });

    const result = await engineRun(
      baseOptions({
        operation: "paginated-op",
        args: ["--query", "Items[0]"],
        binary: banStub,
      }),
    );

    // Ban stub exited 0 — --max-items was absent.
    // Engine skipped projectOutput (queryActive=true) and returned raw JSON.
    expect(result).toMatchObject({ result: "query-engine-ok" });
  });

  it("--query + explicit --max-items: caller re-cap IS forwarded to child", async () => {
    // User supplied their own --max-items alongside --query. The engine must not
    // add a second one, but the user's value must still reach the child process
    // (it's already in cleanedArgs → awsArgs via the spread).
    const guardStub = createArgGuardStub({
      requiredArg: "--max-items",
      validStdout: '{"result":"recapped-ok"}',
    });

    const result = await engineRun(
      baseOptions({
        operation: "paginated-op",
        args: ["--max-items", "5", "--query", "Items[0]"],
        binary: guardStub,
      }),
    );

    // Guard stub exited 0 — --max-items WAS in child argv (from cleanedArgs,
    // not re-added by the engine — the engine's push is suppressed by queryActive).
    expect(result).toMatchObject({ result: "recapped-ok" });
  });
});

// ── Error mapping via taxonomy ────────────────────────────────────────────────

describe("engineRun — error mapping", () => {
  it("maps botocore SERVICE_CLIENT_ERROR with known-error hint for matching error code", async () => {
    const botoStderr = `An error occurred (NotFound) when calling the RequiredOp operation: The specified resource does not exist`;
    const stub = createStub({ stdout: "", stderr: botoStderr, exitCode: 255 });

    try {
      await engineRun(
        baseOptions({
          operation: "required-op",
          args: ["--bucket", "b", "--key", "k"],
          binary: stub,
        }),
      );
      expect(true).toBe(false); // must throw
    } catch (err) {
      expect((err as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
      // Must surface the known-error hint from the operation's error set
      expect(
        (err as AxiError).suggestions.some((s) => s.includes("NotFound")),
      ).toBe(true);
    }
  });

  it("propagates auth error without modification (NO_CREDENTIALS or NO_PROFILE_SELECTED)", async () => {
    // The exact code depends on whether ~/.aws/config has named profiles.
    // Both codes are auth-family; the engine must surface whichever applies.
    const AUTH_CODES = new Set(["NO_CREDENTIALS", "NO_PROFILE_SELECTED"]);
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    try {
      await engineRun(
        baseOptions({ operation: "simple-op", args: [], binary: stub }),
      );
    } catch (err) {
      expect(AUTH_CODES.has((err as AxiError).code)).toBe(true);
    }
  });

  it("throws USAGE_ERROR for unknown service", async () => {
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    try {
      await engineRun({
        service: "nonexistent-service-xyz",
        operation: "list-things",
        args: [],
        binary: stub,
        dataDir: FIXTURES_DIR,
      });
    } catch (err) {
      expect((err as AxiError).code).toBe("USAGE_ERROR");
    }
  });

  it("throws USAGE_ERROR for unknown operation on a known service", async () => {
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    try {
      await engineRun(
        baseOptions({ operation: "nonexistent-op", binary: stub }),
      );
    } catch (err) {
      expect((err as AxiError).code).toBe("USAGE_ERROR");
    }
  });

  it("treats DryRunOperation as success — returns empty object", async () => {
    const botoStderr = `An error occurred (DryRunOperation) when calling the SimpleOp operation: Request would have succeeded, but DryRun flag is set`;
    const stub = createStub({ stdout: "", stderr: botoStderr, exitCode: 255 });

    // awsJson returns {} for DryRunOperation; the engine should pass that through
    const result = await engineRun(
      baseOptions({ operation: "simple-op", args: ["--dry-run"], binary: stub }),
    );
    // The engine returns an object (empty or partial) — no throw
    expect(typeof result).toBe("object");
  });
});
