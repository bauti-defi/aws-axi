import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { releaseStubBins, stubBin, stubDir } from "./helpers/stub-bin.js";
import { useEnvGuard } from "./helpers/env-guard.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const tempDirs: string[] = [];

useEnvGuard();

afterEach(() => {
  releaseStubBins();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function captureMain(
  argv: string[],
  env: Record<string, string>,
): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const previousExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await main({ argv, stdout: { write: (chunk: string): true => (chunks.push(chunk), true) } });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = previousExitCode;
  return { output: chunks.join(""), exitCode };
}

function createArgvStub(): { binary: string; readArgv: () => string[] } {
  const directory = mkdtempSync(join(tmpdir(), "aws-axi-ecs-waiter-"));
  tempDirs.push(directory);
  const logFile = join(directory, "argv.log");
  const binary = stubBin(`#!/bin/sh\nprintf '%s\\n' "$@" > '${logFile}'\nexit 0\n`);

  return {
    binary,
    readArgv: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

describe("nested ECS waiter syntax", () => {
  it("routes ecs wait tasks-stopped through the shared waiter with its AWS arguments", async () => {
    const { binary, readArgv } = createArgvStub();

    const { output, exitCode } = await captureMain(
      [
        "ecs",
        "wait",
        "tasks-stopped",
        "--cluster",
        "arn:aws:ecs:us-east-1:123456789012:cluster/app",
        "--tasks",
        "arn:aws:ecs:us-east-1:123456789012:task/app/abc",
      ],
      {
        AWS_DATA_PATH: FIXTURES_DIR,
        PATH: `${stubDir(binary)}:${process.env.PATH ?? ""}`,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("waited: true");
    expect(output).toContain("service: ecs");
    expect(output).toContain("waiter: tasks-stopped");
    expect(output).toContain("targetOp: DescribeTasks");
    expect(readArgv()).toEqual([
      "ecs",
      "wait",
      "tasks-stopped",
      "--cluster",
      "arn:aws:ecs:us-east-1:123456789012:cluster/app",
      "--tasks",
      "arn:aws:ecs:us-east-1:123456789012:task/app/abc",
      "--output",
      "json",
    ]);
  });

  it("preserves explicit wait ecs tasks-stopped syntax", async () => {
    const { binary, readArgv } = createArgvStub();

    const { output, exitCode } = await captureMain(
      ["wait", "ecs", "tasks-stopped", "--cluster", "app", "--tasks", "abc"],
      {
        AWS_DATA_PATH: FIXTURES_DIR,
        PATH: `${stubDir(binary)}:${process.env.PATH ?? ""}`,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("waiter: tasks-stopped");
    expect(readArgv().slice(0, 7)).toEqual([
      "ecs",
      "wait",
      "tasks-stopped",
      "--cluster",
      "app",
      "--tasks",
      "abc",
    ]);
  });

  it("retains the s3api-to-s3 waiter model remap for nested syntax", async () => {
    const { binary, readArgv } = createArgvStub();

    const { output, exitCode } = await captureMain(
      ["s3api", "wait", "bucket-exists", "--bucket", "my-bucket"],
      {
        AWS_DATA_PATH: FIXTURES_DIR,
        PATH: `${stubDir(binary)}:${process.env.PATH ?? ""}`,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("service: s3");
    expect(readArgv().slice(0, 5)).toEqual([
      "s3api",
      "wait",
      "bucket-exists",
      "--bucket",
      "my-bucket",
    ]);
  });

  it("reports an unknown nested waiter as a usage error", async () => {
    const { output, exitCode } = await captureMain(
      ["ecs", "wait", "not-a-waiter"],
      { AWS_DATA_PATH: FIXTURES_DIR },
    );

    expect(exitCode).toBe(252);
    expect(output).toContain("Unknown waiter 'not-a-waiter' for service 'ecs'");
  });

  it("retains the generic unknown-operation error for non-wait ECS operations", async () => {
    const { output, exitCode } = await captureMain(
      ["ecs", "not-an-operation"],
      { AWS_DATA_PATH: FIXTURES_DIR },
    );

    expect(exitCode).toBe(252);
    expect(output).toContain("Unknown operation 'not-an-operation' for service 'ecs'");
  });
});
