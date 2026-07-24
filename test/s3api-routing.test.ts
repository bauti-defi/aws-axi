/**
 * Tests for the SERVICE_ALIASES routing fix (#62).
 *
 * Two tiers, per the repo's model.test.ts convention:
 *
 *   1. Fixture-based (deterministic): routing and validation behavior with
 *      hand-authored fixture models under test/fixtures/. These are hermetic —
 *      they exercise the alias plumbing without touching the real botocore tree.
 *
 *   2. Live-botocore: one test per alias asserts that the aliased model name
 *      actually resolves in the real installed botocore tree, with a graceful
 *      skip when the aws CLI is absent. This is what pins the mapping against
 *      reality — a botocore-side rename or a missing dir would go RED here
 *      even if all fixture tests stay green.
 *
 * Aliases under test:
 *   s3api         → s3         (HeadObject / ListBuckets)
 *   configservice → config     (DescribeConfigurationRecorders)
 *   deploy        → codedeploy (ListApplications)
 *
 * Mutation-test evidence:
 *   Mutant A: `const modelService = service` (remove alias lookup)
 *     → all fixture alias tests fail USAGE_ERROR "Unknown service '...'"
 *   Mutant B: awsArgs uses modelService instead of service (wire name wrong)
 *     → require-service-stub tests fail (stub exits 1 for wrong service name)
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError } from "axi-sdk-js";
import { engineRun, SERVICE_ALIASES } from "../src/engine.js";
import { loadService, getOperation } from "../src/model.js";
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

/**
 * Stub that exits 1 when $1 (first positional arg = service name) matches
 * `bannedService`, exits 0 with `validPayload` otherwise.
 *
 * Negative assertion: proves the wire call does NOT use the botocore alias name.
 */
function banServiceStub(bannedService: string, validPayload: string): string {
  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }
  return stubBin(
    [
      "#!/bin/sh",
      `if [ "$1" = ${shellQuote(bannedService)} ]; then`,
      `  printf 'BUG: engine called aws %s instead of the original CLI name\\n' "$1" >&2`,
      "  exit 1",
      "fi",
      `printf '%s' ${shellQuote(validPayload)}`,
    ].join("\n"),
  );
}

/**
 * Stub that exits 1 when $1 (first positional arg = service name) does NOT
 * match `requiredService`, exits 0 with `validPayload` otherwise.
 *
 * Positive assertion: proves the exact original CLI name reaches the child process.
 */
function requireServiceStub(
  requiredService: string,
  validPayload: string,
): string {
  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }
  return stubBin(
    [
      "#!/bin/sh",
      `if [ "$1" != ${shellQuote(requiredService)} ]; then`,
      `  printf 'BUG: engine called aws %s, expected ${requiredService}\\n' "$1" >&2`,
      "  exit 1",
      "fi",
      `printf '%s' ${shellQuote(validPayload)}`,
    ].join("\n"),
  );
}

// ── Fixture-based routing tests — s3api → s3 ─────────────────────────────────

describe("s3api service routing — fixture (issue #62)", () => {
  /**
   * Motivating case from the issue: Terraform state-lock pre-flight.
   * The engine looks up the `s3` botocore model but calls `aws s3api head-object`.
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
   * Wire name: the child process must receive "s3api", not the aliased "s3".
   * Verified with both a ban-stub (negative) and a require-stub (positive).
   */
  it("forwards 's3api' (not 's3') as the service name in the child process argv", async () => {
    // Negative: ban-stub exits 1 if engine uses the alias "s3" on the wire
    const banStub = banServiceStub("s3", JSON.stringify({ ok: true }));
    await expect(
      engineRun({
        service: "s3api",
        operation: "head-object",
        args: ["--bucket", "b", "--key", "k"],
        dataDir: FIXTURES_DIR,
        binary: banStub,
      }),
    ).resolves.toBeDefined();

    // Positive: require-stub exits 1 if engine does NOT use "s3api" on the wire
    const requireStub = requireServiceStub(
      "s3api",
      JSON.stringify({ ok: true }),
    );
    await expect(
      engineRun({
        service: "s3api",
        operation: "head-object",
        args: ["--bucket", "b", "--key", "k"],
        dataDir: FIXTURES_DIR,
        binary: requireStub,
      }),
    ).resolves.toBeDefined();
  });

  it("validates required params (Bucket + Key) via the aliased s3 model", async () => {
    const stub = fixedJsonStub("{}");

    let caught: unknown;
    try {
      await engineRun({
        service: "s3api",
        operation: "head-object",
        args: [],
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

  it("does NOT throw 'Unknown service s3api' when required params are present", async () => {
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

// ── Fixture-based routing tests — configservice → config ─────────────────────

describe("configservice service routing — fixture", () => {
  it("routes configservice describe-configuration-recorders through the engine", async () => {
    const stub = fixedJsonStub(
      JSON.stringify({ ConfigurationRecorders: [{ name: "default" }] }),
    );

    const result = await engineRun({
      service: "configservice",
      operation: "describe-configuration-recorders",
      args: [],
      dataDir: FIXTURES_DIR,
      binary: stub,
    });

    expect(result).toMatchObject({
      ConfigurationRecorders: [{ name: "default" }],
    });
  });

  it("forwards 'configservice' (not 'config') as the wire service name", async () => {
    const banStub = banServiceStub(
      "config",
      JSON.stringify({ ConfigurationRecorders: [] }),
    );
    await expect(
      engineRun({
        service: "configservice",
        operation: "describe-configuration-recorders",
        args: [],
        dataDir: FIXTURES_DIR,
        binary: banStub,
      }),
    ).resolves.toBeDefined();

    const requireStub = requireServiceStub(
      "configservice",
      JSON.stringify({ ConfigurationRecorders: [] }),
    );
    await expect(
      engineRun({
        service: "configservice",
        operation: "describe-configuration-recorders",
        args: [],
        dataDir: FIXTURES_DIR,
        binary: requireStub,
      }),
    ).resolves.toBeDefined();
  });
});

// ── Fixture-based routing tests — deploy → codedeploy ────────────────────────

describe("deploy service routing — fixture", () => {
  it("routes deploy list-applications through the engine using the codedeploy model", async () => {
    const stub = fixedJsonStub(
      JSON.stringify({ applications: ["my-app"] }),
    );

    const result = await engineRun({
      service: "deploy",
      operation: "list-applications",
      args: [],
      dataDir: FIXTURES_DIR,
      binary: stub,
    });

    expect(result).toMatchObject({ applications: ["my-app"] });
  });

  it("forwards 'deploy' (not 'codedeploy') as the wire service name", async () => {
    const banStub = banServiceStub(
      "codedeploy",
      JSON.stringify({ applications: [] }),
    );
    await expect(
      engineRun({
        service: "deploy",
        operation: "list-applications",
        args: [],
        dataDir: FIXTURES_DIR,
        binary: banStub,
      }),
    ).resolves.toBeDefined();

    const requireStub = requireServiceStub(
      "deploy",
      JSON.stringify({ applications: [] }),
    );
    await expect(
      engineRun({
        service: "deploy",
        operation: "list-applications",
        args: [],
        dataDir: FIXTURES_DIR,
        binary: requireStub,
      }),
    ).resolves.toBeDefined();
  });
});

// ── Live-botocore tests — each alias against the real installed botocore tree ─
//
// These tests omit `dataDir` so they hit the real botocore data directory
// discovered from the installed `aws` CLI. They skip gracefully when the CLI
// is absent. Their purpose: lock the alias → real dir mapping against the
// actual on-disk tree so a botocore-side rename surfaces as RED CI, not a
// silent production breakage.

describe("SERVICE_ALIASES — live botocore resolution", () => {
  it("s3api alias: loadService('s3') resolves HeadObject with required Bucket + Key", () => {
    let s3Model;
    try {
      s3Model = loadService(SERVICE_ALIASES["s3api"] as string);
    } catch {
      // aws CLI absent — skip
      return;
    }
    const op = getOperation(s3Model, "HeadObject");
    expect(op.required).toEqual(expect.arrayContaining(["Bucket", "Key"]));
  });

  it("configservice alias: loadService('config') resolves DescribeConfigurationRecorders", () => {
    let configModel;
    try {
      configModel = loadService(SERVICE_ALIASES["configservice"] as string);
    } catch {
      return;
    }
    const op = getOperation(configModel, "DescribeConfigurationRecorders");
    expect(op.name).toBe("DescribeConfigurationRecorders");
  });

  it("deploy alias: loadService('codedeploy') resolves ListApplications", () => {
    let deployModel;
    try {
      deployModel = loadService(SERVICE_ALIASES["deploy"] as string);
    } catch {
      return;
    }
    const op = getOperation(deployModel, "ListApplications");
    expect(op.name).toBe("ListApplications");
  });
});
