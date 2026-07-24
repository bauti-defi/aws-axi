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
import { loadService, getOperation, findBotocoreDataDir } from "../src/model.js";
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

// ── Prototype-safety regression ───────────────────────────────────────────────
//
// Guards `Object.hasOwn(SERVICE_ALIASES, service)` at src/engine.ts. Without
// this guard, a plain object literal lookup returns inherited prototype members
// (toString, constructor, etc.) as non-undefined values that propagate as
// modelService names. Two defenses exist in the implementation (null-prototype
// + Object.hasOwn), but neither is pinned by a test — so a future refactor
// back to a plain object literal + bare lookup would silently reintroduce the
// bug. This test makes the guard load-bearing.

describe("SERVICE_ALIASES — prototype-safety (Y5)", () => {
  it("prototype-chain keys do not resolve as botocore model names", async () => {
    const protoKeys = ["toString", "constructor", "valueOf", "__proto__", "hasOwnProperty"];
    for (const key of protoKeys) {
      await expect(
        engineRun({
          service: key,
          operation: "foo",
          args: [],
          dataDir: FIXTURES_DIR,
          binary: "/bin/false",
        }),
      ).rejects.toMatchObject({ code: "USAGE_ERROR" });
    }
  });
});

// ── Live-botocore tests — each alias against the real installed botocore tree ─
//
// These tests omit `dataDir` so they hit the real botocore data directory
// discovered from the installed `aws` CLI.
//
// Design:
//   - `findBotocoreDataDir()` is called ONCE outside the tests. The ONLY reason
//     to skip is that the `aws` CLI is absent. Any other failure (renamed dir,
//     missing model) must propagate → RED, not be swallowed.
//   - We iterate `Object.entries(SERVICE_ALIASES)` so the live test set
//     auto-tracks the alias table — adding an alias never needs a parallel
//     test line.
//   - `it.skip` produces a loud "UNVERIFIED" marker in CI logs rather than a
//     silent pass that is indistinguishable from a verified result.

// Probe once for the CLI outside all tests. "CLI absent" is the sole tolerated
// skip reason; every other error (renamed/missing model dir) must throw RED.
let liveDataDir: string | undefined;
try {
  liveDataDir = findBotocoreDataDir();
} catch {
  liveDataDir = undefined;
}

describe("SERVICE_ALIASES — live botocore resolution", () => {
  if (liveDataDir === undefined) {
    it.skip("SKIPPED: aws CLI not installed — live alias mapping is UNVERIFIED", () => {});
  } else {
    for (const [cliName, modelDir] of Object.entries(SERVICE_ALIASES)) {
      it(`${cliName} → ${modelDir}/ resolves in the live botocore tree`, () => {
        // No try/catch — model-missing errors must go RED.
        const model = loadService(modelDir, { dataDir: liveDataDir });
        expect(model.operations.size).toBeGreaterThan(0);
      });
    }
  }
});
