/**
 * E2E tests for the CLI-level generic engine fallback dispatch.
 *
 * Verifies that `main()` routes unknown services (no hand overlay) through
 * the model-driven engine, while existing overlays (whoami, ec2, kms) still
 * take precedence.
 *
 * Uses real stub `aws` binaries via the seam — no function mocks.
 * Uses the fake-svc fixture model via AWS_DATA_PATH injection.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { SERVICE_ALIASES } from "../src/engine.js";
import { stubBin, stubDir, releaseStubBins } from "./helpers/stub-bin.js";
import { useEnvGuard } from "./helpers/env-guard.js";

afterEach(() => {
  releaseStubBins();
});

// Guard the full process.env (and process.exitCode) around each test.
// See test/helpers/env-guard.ts for the rationale and the guard test.
useEnvGuard();

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ── Stub helpers ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

interface StubSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function createStub(spec: StubSpec): string {

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

  const p = stubBin(lines);
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

/**
 * Capture stdout output from main() as a string.
 *
 * NOTE: `process.exitCode = undefined` is a no-op in Bun — once set to a
 * non-zero value it STAYS there until overwritten with a concrete value (e.g.
 * 0). We therefore use 0 as the "clean" baseline for the exitCode contract:
 *   - exitCode returned as `undefined` means main() left it at 0 (success).
 *   - Any non-zero exitCode is propagated verbatim.
 */
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

  // Save and inject test env vars.
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  // Reset to 0 (NOT undefined — that is a no-op in Bun).
  const prevExitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  try {
    await main({ argv, stdout });
  } finally {
    // Restore env vars regardless of outcome.
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  // Capture: treat 0 as "success / no exit code set" (map to undefined).
  const rawExitCode = process.exitCode as number;
  const exitCode: number | undefined = rawExitCode === 0 ? undefined : rawExitCode;

  // Restore — use prevExitCode (which is at least 0, never undefined).
  process.exitCode = prevExitCode;

  return { output: chunks.join(""), exitCode };
}

// ── Proxy denylist — reserved keys must NOT route to the engine ──────────────

describe("CLI engine Proxy — denylist guards", () => {
  /**
   * Before the denylist fix, `commands["update"]` returned a truthy engine
   * handler, making `runAxiCli`'s self-update gate (`!options.commands.update`)
   * always false. After the fix, "update" returns undefined so the gate works.
   *
   * Observable difference: without the fix, `main(["update", "--help"])` would
   * route to engineRun with service="update" and emit USAGE_ERROR "Unknown
   * service 'update'". With the fix, runAxiCli's built-in update handler emits
   * help text (--help is synchronous, no network I/O — safe in CI).
   */
  it("'update' command is NOT routed to the generic engine", async () => {
    const { output } = await captureMain(["update", "--help"], {
      AWS_DATA_PATH: FIXTURES_DIR,
    });
    // Engine dispatch would produce this specific message — verify it doesn't.
    expect(output).not.toMatch(/Unknown service ['"]update['"]/);
    // The built-in update help handler emits output about the update command.
    expect(output).toContain("update");
  });

  /**
   * "then"/"catch"/"finally" in the Proxy create a thenable footgun:
   * `Promise.resolve(commands)` would detect the object as a thenable and
   * try to resolve through it, causing infinite recursion or unexpected behavior.
   * The denylist prevents these keys from ever returning a handler.
   */
  it("'then' is NOT routed to the generic engine", async () => {
    const { output } = await captureMain(["then"], {
      AWS_DATA_PATH: FIXTURES_DIR,
    });
    expect(output).not.toMatch(/Unknown service ['"]then['"]/);
  });
});

// ── Overlay services still work ───────────────────────────────────────────────

describe("CLI engine fallback — overlay services take precedence", () => {
  it("routes whoami to the overlay (not the engine)", async () => {
    // whoami calls sts get-caller-identity — stub returns valid STS JSON
    const stub = createStub({
      stdout: JSON.stringify({
        Account: "123456789012",
        UserId: "AIDATEST",
        Arn: "arn:aws:iam::123456789012:user/test",
      }),
      exitCode: 0,
    });

    const { output, exitCode } = await captureMain(
      ["whoami"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
      },
    );

    // whoami overlay produces its curated output; presence of "account" confirms overlay ran
    expect(output).toContain("account");
    expect(exitCode).toBeUndefined(); // success
  });
});

// ── Generic engine fallback via CLI ──────────────────────────────────────────

describe("CLI engine fallback — generic service dispatch", () => {
  it("dispatches fake-svc simple-op through the engine and returns TOON output", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ Value: "engine-works" }),
      exitCode: 0,
    });

    const { output, exitCode } = await captureMain(
      ["fake-svc", "simple-op"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("engine-works");
    expect(exitCode).toBeUndefined(); // success
  });

  it("returns USAGE_ERROR (exit 252) when required params are missing", async () => {
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["fake-svc", "required-op"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("--bucket");
    expect(output).toContain("--key");
    expect(exitCode).toBe(252);
  });

  it("returns USAGE_ERROR (exit 252) when operation is missing for a generic service", async () => {
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["fake-svc"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("operation required");
    expect(exitCode).toBe(252);
  });

  it.each([
    ["ddb", undefined],
    ["ddb", "put"],
    ["ddb", "select"],
  ])(
    "rejects aws ddb's %s interface with aws-axi alternatives before model lookup",
    async (service: string, operation: string | undefined) => {
      const argv = operation === undefined ? [service] : [service, operation];
      const { output, exitCode } = await captureMain(argv, {
        AWS_DATA_PATH: FIXTURES_DIR,
      });

      expect(exitCode).toBe(252);
      expect(output).toContain("aws-axi ddb is not supported");
      expect(output).toContain("aws-axi dynamodb");
      expect(output).toContain("aws ddb");
      expect(output).not.toMatch(/Unknown service ['"]ddb['"]/);
    },
  );

  it("does not alias ddb to dynamodb", () => {
    expect(Object.hasOwn(SERVICE_ALIASES, "ddb")).toBe(false);
  });

  it("returns paginated output with count + nextToken hint", async () => {
    const paginatedResponse = JSON.stringify({
      Items: ["a", "b", "c"],
      NextToken: "tok123",
    });
    const stub = createStub({ stdout: paginatedResponse, exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["fake-svc", "paginated-op"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("tok123");
    expect(exitCode).toBeUndefined(); // success
  });
});

/**
 * `configure` is an AWS CLI meta-command, not a botocore service.
 * `list-profiles` must delegate to `aws configure list-profiles` and exit 0.
 *
 * The hermetic home contains only placeholder profile names. `example` lives
 * in the config file; `sample` lives only in the credentials file. A local
 * config-file parser would miss `sample` and diverge from the AWS CLI.
 */
function awsConfigureListProfiles(env: Record<string, string>): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    "aws",
    ["configure", "list-profiles"],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        ...env,
      },
      encoding: "utf8",
    },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    },
  );
  return promise;
}

describe("configure list-profiles — meta-command, not a botocore service", () => {
  it("lists hermetic placeholder profiles and exits 0, matching aws configure list-profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-configure-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config");
    const credentialsPath = join(dir, "credentials");
    writeFileSync(configPath, "[profile example]\nregion = us-east-1\n", "utf8");
    writeFileSync(credentialsPath, "[sample]\n", "utf8");

    const isolated = {
      AWS_CONFIG_FILE: configPath,
      AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
      HOME: dir,
    };

    const expected = await awsConfigureListProfiles(isolated);
    expect(expected).toBe("example\nsample\n");

    const { output, exitCode } = await captureMain(
      ["configure", "list-profiles"],
      isolated,
    );

    expect(exitCode).toBeUndefined();
    expect(output).toBe(expected);
    expect(output).not.toContain("Unknown service");
  });
});

/**
 * `ecr get-login-password` is an AWS CLI *custom* operation, not a botocore
 * API operation. Before the fix, aws-axi looked it up in the ECR service model,
 * found no such operation, and exited 252 with "Unknown operation
 * 'get-login-password' for service 'ecr'".
 *
 * The fix routes it to the real `aws` CLI via awsExec, streaming stdout straight
 * through. The stub `aws` binary stands in for the registry call — the test
 * asserts delegation (no 252, no "Unknown operation", token forwarded verbatim),
 * never contacts a real registry, and uses only a placeholder token string.
 */
describe("ecr get-login-password — custom op, not a botocore operation", () => {
  it("delegates to the aws CLI and streams stdout through instead of exiting 252", async () => {
    // Placeholder token — never a real ECR authorization token.
    const placeholderToken = "AXI-PLACEHOLDER-TOKEN\n";
    const stub = createStub({ stdout: placeholderToken, exitCode: 0 });

    const { output, exitCode } = await captureMain(
      ["ecr", "get-login-password", "--region", "us-east-1"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    // Delegated, not rejected: no USAGE_ERROR, no unknown-operation message.
    expect(exitCode).not.toBe(252);
    expect(exitCode).toBeUndefined(); // success (exit 0)
    expect(output).not.toMatch(/Unknown operation/);
    // Stdout streamed straight through, verbatim.
    expect(output).toBe(placeholderToken);
  });

  it("forwards the ecr get-login-password argv to the aws CLI, region via env", async () => {
    // Echo argv on stdout and the forwarded region env so we can assert the
    // delegated command shape without depending on a real registry.
    const stub = stubBin(
      ["#!/bin/sh", 'printf "%s " "$@"', 'printf "region=%s" "$AWS_REGION"', "exit 0"].join("\n"),
    );

    const { output, exitCode } = await captureMain(
      ["ecr", "get-login-password", "--region", "us-east-1"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(exitCode).toBeUndefined();
    // The custom op is delegated verbatim; --region is lifted into context and
    // forwarded to the child as AWS_REGION rather than an argv flag.
    expect(output).toContain("ecr get-login-password");
    expect(output).toContain("region=us-east-1");
  });
});
