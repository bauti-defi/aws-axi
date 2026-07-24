/**
 * Tests for s3api service routing (#62).
 *
 * `aws-axi s3api <op>` must route through the generic engine, using the `s3`
 * botocore model for validation while forwarding `s3api` as the service name
 * to the underlying `aws` CLI call.
 *
 * Fixture: test/fixtures/s3/ — a minimal S3 model with HeadObject and
 * ListBuckets, standing in for the real botocore s3/ data directory.
 *
 * Mutation-test evidence (run manually to confirm RED):
 *   In src/engine.ts, comment out the SERVICE_ALIASES lookup so `service` is
 *   always used as-is for `loadService`. Both tests below flip to:
 *     USAGE_ERROR "Unknown service 's3api'"
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError } from "axi-sdk-js";
import { engineRun } from "../src/engine.js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ── Helper stubs ──────────────────────────────────────────────────────────────

/**
 * Stub that returns a fixed JSON payload on stdout (exit 0).
 */
function fixedJsonStub(payload: string): string {
  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }
  return stubBin(
    ["#!/bin/sh", `printf '%s' ${shellQuote(payload)}`].join("\n"),
  );
}

// ── Core routing test: s3api aliases to s3 model ─────────────────────────────

describe("s3api service routing — issue #62", () => {
  /**
   * Motivating case from the issue: Terraform state-lock pre-flight.
   *
   * The engine must:
   *   1. Look up `s3` in botocore (HEAD_OBJECT requires Bucket + Key)
   *   2. Call the stub with argv: ["s3api", "head-object", "--bucket", "b", "--key", "k", "--output", "json"]
   *   3. Return the parsed output without error
   */
  it("routes s3api head-object through the engine using the s3 botocore model", async () => {
    const stub = fixedJsonStub(
      JSON.stringify({ ContentLength: 1234, ETag: '"abc123"' }),
    );

    const result = await engineRun({
      service: "s3api",
      operation: "head-object",
      args: ["--bucket", "b", "--key", "k"],
      dataDir: FIXTURES_DIR,
      binary: stub,
    });

    expect(result).toMatchObject({ ContentLength: 1234, ETag: '"abc123"' });
  });

  /**
   * Child argv assertion: the CLI call must use "s3api" as the service name,
   * NOT "s3". The alias only affects model lookup — the wire call is unchanged.
   *
   * Uses a ban-stub: exits 1 if the first positional arg ($1) is "s3" instead
   * of "s3api". When the engine correctly forwards "s3api", the stub exits 0.
   *
   * Mutation evidence: remove the SERVICE_ALIASES lookup in engine.ts so service
   * is also used for the aws call (it won't change — service IS "s3api"), but
   * comment-out the alias in loadService so it tries "s3api" as model name →
   * the first 4 tests go RED with USAGE_ERROR. This test goes RED only if the
   * awsArgs construction were changed to use modelService instead of service.
   */
  it("forwards 's3api' (not 's3') as the service name in the child process argv", async () => {
    // Ban-stub: exits 1 when $1 == "s3"; exits 0 with valid JSON when $1 == "s3api".
    // If the engine mistakenly used the aliased model name "s3" as the CLI service
    // name, this stub would fail, proving the alias is model-only.
    const banWrongServiceStub = stubBin(
      [
        "#!/bin/sh",
        'if [ "$1" = "s3" ]; then',
        "  printf 'BUG: engine called aws s3 instead of aws s3api\\n' >&2",
        "  exit 1",
        "fi",
        `printf '%s' '${JSON.stringify({ ServiceName: "ok" })}'`,
      ].join("\n"),
    );

    const result = await engineRun({
      service: "s3api",
      operation: "head-object",
      args: ["--bucket", "b", "--key", "k"],
      dataDir: FIXTURES_DIR,
      binary: banWrongServiceStub,
    });

    // Stub exited 0 → engine called "s3api", not "s3".
    expect(result).toMatchObject({ ServiceName: "ok" });
  });

  /**
   * Required-param validation uses the s3 model: Bucket and Key are required
   * for HeadObject. Omitting them must produce a USAGE_ERROR listing the
   * missing flags — proving the model lookup succeeded.
   */
  it("validates required params (Bucket + Key) via the aliased s3 model", async () => {
    const stub = fixedJsonStub("{}");

    let caught: unknown;
    try {
      await engineRun({
        service: "s3api",
        operation: "head-object",
        args: [], // missing --bucket and --key
        dataDir: FIXTURES_DIR,
        binary: stub,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AxiError);
    const axErr = caught as AxiError;
    expect(axErr.code).toBe("USAGE_ERROR");
    expect(axErr.message).toContain("--bucket");
    expect(axErr.message).toContain("--key");
  });

  /**
   * Without the fix, s3api returns USAGE_ERROR "Unknown service 's3api'".
   * This regression guard ensures the error is NOT thrown when both params
   * are provided (i.e., the service routes correctly to the s3 model).
   */
  it("does NOT throw 'Unknown service s3api' when both required params are present", async () => {
    const stub = fixedJsonStub(JSON.stringify({ ContentLength: 0 }));

    await expect(
      engineRun({
        service: "s3api",
        operation: "head-object",
        args: ["--bucket", "my-bucket", "--key", "my-key"],
        dataDir: FIXTURES_DIR,
        binary: stub,
      }),
    ).resolves.toBeDefined();
  });

  /**
   * s3api list-buckets — covers the non-required-param path.
   * ListBuckets has no required params; it must succeed without flags.
   */
  it("routes s3api list-buckets (no required params)", async () => {
    const stub = fixedJsonStub(
      JSON.stringify({ Buckets: [{ Name: "my-bucket" }] }),
    );

    const result = await engineRun({
      service: "s3api",
      operation: "list-buckets",
      args: [],
      dataDir: FIXTURES_DIR,
      binary: stub,
    });

    expect(result).toMatchObject({ Buckets: [{ Name: "my-bucket" }] });
  });
});
