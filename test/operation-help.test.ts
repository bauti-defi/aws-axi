/**
 * `<service> <operation> --help` / `-h` must print operation help and exit 0.
 *
 * `--help` is a documented aws-axi flag. It must not be forwarded to `aws`,
 * which rejects it with a generic usage banner and exit 252.
 *
 * The ecs model is a hermetic fixture so the test does not depend on the
 * installed AWS CLI's botocore tree. The stub `aws` records every invocation
 * and emits the generic banner — a correct intercept never starts it.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { stubBin, stubDir, releaseStubBins } from "./helpers/stub-bin.js";
import { useEnvGuard } from "./helpers/env-guard.js";

afterEach(() => {
  releaseStubBins();
});

useEnvGuard();

const GENERIC_BANNER =
  "usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeEcsModel(root: string): void {
  const versionDir = join(root, "ecs", "2014-11-13");
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    join(versionDir, "service-2.json"),
    JSON.stringify({
      version: "2.0",
      metadata: { apiVersion: "2014-11-13", serviceId: "ECS" },
      operations: {
        ListTasks: {
          name: "ListTasks",
          input: { shape: "ListTasksRequest" },
          output: { shape: "ListTasksResponse" },
        },
        RunTask: {
          name: "RunTask",
          input: { shape: "RunTaskRequest" },
          output: { shape: "RunTaskResponse" },
        },
      },
      shapes: {
        ListTasksRequest: {
          type: "structure",
          members: {
            Cluster: { shape: "StringType" },
            DesiredStatus: { shape: "StringType" },
          },
        },
        ListTasksResponse: {
          type: "structure",
          members: { TaskArns: { shape: "StringType" } },
        },
        RunTaskRequest: {
          type: "structure",
          required: ["Cluster"],
          members: { Cluster: { shape: "StringType" } },
        },
        RunTaskResponse: {
          type: "structure",
          members: { Tasks: { shape: "StringType" } },
        },
        StringType: { type: "string" },
      },
    }),
    "utf8",
  );
}

function bannerStub(marker: string): string {
  return stubBin(
    [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" > '${marker}'`,
      `printf '%s\\n' '${GENERIC_BANNER}' >&2`,
      "exit 252",
    ].join("\n"),
  );
}

async function captureMain(
  argv: string[],
  env: Record<string, string>,
): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const stdout = {
    write(chunk: string): true {
      chunks.push(chunk);
      return true;
    },
  };

  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const prevExitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  try {
    await main({ argv, stdout });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  const rawExitCode = process.exitCode as number;
  const exitCode: number | undefined = rawExitCode === 0 ? undefined : rawExitCode;
  process.exitCode = prevExitCode;
  return { output: chunks.join(""), exitCode };
}

describe("operation help — do not forward --help/-h to aws", () => {
  it("ecs list-tasks --help exits 0 and prints list-tasks parameters, not the generic banner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeEcsModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output, exitCode } = await captureMain(
      ["ecs", "list-tasks", "--help"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("list-tasks");
    expect(output).toContain("--cluster");
    expect(output).toContain("--desired-status");
    expect(output).not.toContain(GENERIC_BANNER);
    expect(output).not.toContain("USAGE_ERROR");
    expect(existsSync(marker)).toBe(false);
  });

  it("ecs list-tasks -h exits 0 with the same operation help and does not call aws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeEcsModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output, exitCode } = await captureMain(
      ["ecs", "list-tasks", "-h"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("list-tasks");
    expect(output).toContain("--cluster");
    expect(output).not.toContain(GENERIC_BANNER);
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps --help when a global --region flag is also present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeEcsModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output, exitCode } = await captureMain(
      ["ecs", "list-tasks", "--region", "us-east-1", "--help"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("list-tasks");
    expect(output).toContain("--cluster");
    expect(existsSync(marker)).toBe(false);
  });

  it("prints help for a required-param operation without demanding the parameter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeEcsModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output, exitCode } = await captureMain(
      ["ecs", "run-task", "--help"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("run-task");
    expect(output).toContain("--cluster");
    expect(output).toContain("required");
    expect(output).not.toContain("Missing required");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not forward ssm start-session --help to aws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeEcsModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output, exitCode } = await captureMain(
      ["ssm", "start-session", "--help"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("start-session");
    expect(output).not.toContain(GENERIC_BANNER);
    expect(existsSync(marker)).toBe(false);
  });
});

