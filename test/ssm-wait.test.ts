/**
 * SSM waiter delegation (#139).
 *
 * `aws ssm wait <waiter-name>` is an AWS CLI waiter subcommand, not a botocore
 * API operation. The SSM overlay must recognise the `wait <waiter>` form and
 * delegate it to the real `aws` CLI (`aws ssm wait <waiter> …`) so that
 * validation happens at the AWS layer — a no-target call fails on missing
 * waiter parameters, NOT as an "Unknown operation 'wait'" USAGE_ERROR (exit 252).
 *
 * Tests run against a REAL subprocess stub `aws` binary that logs its argv —
 * no mock clients at the exec-seam boundary. The stub stands in for the AWS
 * CLI so we can assert the exact delegated argv and prove the overlay no longer
 * rejects `wait`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { releaseStubBins, stubBin, stubDir } from "./helpers/stub-bin.js";
import { useEnvGuard } from "./helpers/env-guard.js";

useEnvGuard();

const tempDirs: string[] = [];

afterEach(() => {
  releaseStubBins();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function captureMain(
  argv: string[],
  env: Record<string, string>,
): Promise<{ output: string; errOutput: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const previousExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await main({
      argv,
      stdout: { write: (chunk: string): true => (chunks.push(chunk), true) },
      stderr: { write: (chunk: string): true => (errChunks.push(chunk), true) },
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = previousExitCode;
  return { output: chunks.join(""), errOutput: errChunks.join(""), exitCode };
}

/**
 * A stub `aws` that records its argv to a file and exits 0. Stands in for the
 * real AWS CLI so the test can assert exactly what aws-axi delegated.
 */
function createArgvStub(exitCode = 0): { binary: string; readArgv: () => string[] } {
  const directory = mkdtempSync(join(tmpdir(), "aws-axi-ssm-wait-"));
  tempDirs.push(directory);
  const logFile = join(directory, "argv.log");
  const binary = stubBin(
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${logFile}'\nexit ${exitCode}\n`,
  );

  return {
    binary,
    readArgv: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

describe("ssm wait <waiter> — AWS CLI waiter delegation (#139)", () => {
  it("does NOT reject `wait` as an unknown operation (no exit 252)", async () => {
    const { binary } = createArgvStub();

    const { output, exitCode } = await captureMain(
      ["ssm", "wait", "command-executed"],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    // The bug: `wait` was rejected as an unknown SSM operation → USAGE_ERROR → 252.
    expect(exitCode).not.toBe(252);
    expect(output).not.toContain("Unknown operation 'wait'");
  });

  it("delegates to `aws ssm wait command-executed` (waiter form preserved)", async () => {
    const { binary, readArgv } = createArgvStub();

    await captureMain(["ssm", "wait", "command-executed"], {
      PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
    });

    const argv = readArgv();
    // Proof the overlay delegated the waiter subcommand verbatim to the AWS CLI.
    expect(argv.slice(0, 3)).toEqual(["ssm", "wait", "command-executed"]);
  });

  it("forwards additional waiter flags verbatim to the AWS CLI", async () => {
    const { binary, readArgv } = createArgvStub();

    await captureMain(
      [
        "ssm",
        "wait",
        "command-executed",
        "--command-id",
        "11111111-1111-1111-1111-111111111111",
        "--instance-id",
        "i-0123456789abcdef0",
      ],
      { PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}` },
    );

    const argv = readArgv();
    expect(argv).toContain("--command-id");
    expect(argv).toContain("11111111-1111-1111-1111-111111111111");
    expect(argv).toContain("--instance-id");
    expect(argv).toContain("i-0123456789abcdef0");
  });
});
