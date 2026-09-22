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
 * The fix routes it through the awsInteractive spawn seam (stdio: inherit),
 * the same path ssm start-session uses. The authorization token is streamed
 * child -> terminal; aws-axi NEVER buffers it in memory, and no `--output json`
 * is appended. These tests spawn the real bin/aws-axi.ts against a stub `aws`
 * on PATH — never a real registry, only a placeholder token string — so the
 * inherited-stdio and exact-argv guarantees are observed end to end rather than
 * asserted against a buffered string (which would encode the insecure capture).
 */
describe("ecr get-login-password — custom op, not a botocore operation", () => {
  it("delegates via inherited stdio without appending --output json and preserves the native exit code", async () => {
    // The stub fails loudly if aws-axi appends --output json (proving the
    // buffered buildArgs seam is NOT used) and otherwise emits a placeholder
    // token to its own stdout, which stdio:inherit must pass straight through.
    const binary = stubBin(`#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--output" ] || [ "$arg" = "--output=json" ]; then
    printf '%s\\n' 'unexpected structured output request' >&2
    exit 99
  fi
done
printf '%s' 'AXI-PLACEHOLDER-TOKEN'
exit 0
`);

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "bin/aws-axi.ts",
        "ecr",
        "get-login-password",
        "--region",
        "us-east-1",
      ],
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errorOutput, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    // Delegated, not rejected: no USAGE_ERROR (252), no unknown-operation message.
    expect(exitCode).not.toBe(252);
    expect(errorOutput).not.toMatch(/Unknown operation/);
    // Token inherited straight through the child's stdout; exit 0 preserved.
    expect(exitCode).toBe(0);
    expect(output).toBe("AXI-PLACEHOLDER-TOKEN");
  });

  it("invokes exactly `aws ecr get-login-password` with region forwarded via env, no --output json", async () => {
    // Echo the full child argv and the forwarded region so we can assert the
    // exact delegated command shape.
    const binary = stubBin(`#!/bin/sh
printf 'argv:'
for arg in "$@"; do printf ' %s' "$arg"; done
printf '\\n'
printf 'region=%s\\n' "$AWS_REGION"
exit 0
`);

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "bin/aws-axi.ts",
        "ecr",
        "get-login-password",
        "--region",
        "us-east-1",
      ],
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    // Exact argv: the custom op verbatim, no --output json appended.
    expect(output).toContain("argv: ecr get-login-password\n");
    expect(output).not.toContain("--output");
    // --region is lifted into context and forwarded to the child as AWS_REGION,
    // not passed as an argv flag.
    expect(output).toContain("region=us-east-1");
  });

  it("delegates --help to the aws CLI (native help, exit 0) instead of the engine's 252", async () => {
    const binary = stubBin(`#!/bin/sh
printf '%s\\n' 'Retrieve a token to authenticate to a registry'
exit 0
`);

    const child = Bun.spawn({
      cmd: [process.execPath, "bin/aws-axi.ts", "ecr", "get-login-password", "--help"],
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errorOutput, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(errorOutput).not.toMatch(/Unknown operation/);
    expect(output).toContain("Retrieve a token");
  });
});
