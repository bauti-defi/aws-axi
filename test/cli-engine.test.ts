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
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ── Stub helpers ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

interface StubSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function createStub(spec: StubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-cli-engine-"));
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
        PATH: `${stub.replace(/\/aws$/, "")}:${process.env["PATH"] ?? ""}`,
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
        PATH: `${stub.replace(/\/aws$/, "")}:${process.env["PATH"] ?? ""}`,
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
        PATH: `${stub.replace(/\/aws$/, "")}:${process.env["PATH"] ?? ""}`,
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
        PATH: `${stub.replace(/\/aws$/, "")}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("operation required");
    expect(exitCode).toBe(252);
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
        PATH: `${stub.replace(/\/aws$/, "")}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("tok123");
    expect(exitCode).toBeUndefined(); // success
  });
});
