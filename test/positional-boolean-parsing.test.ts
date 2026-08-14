import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { releaseStubBins, stubBin, stubDir } from "./helpers/stub-bin.js";
import { useEnvGuard } from "./helpers/env-guard.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");
const LOG_GROUP = "/aws/lambda/boolean-literal";

useEnvGuard();

afterEach(() => {
  releaseStubBins();
});

async function captureMain(
  argv: string[],
  env: Record<string, string>,
): Promise<{ output: string; exitCode: number | undefined }> {
  const output: string[] = [];
  const stdout = { write(chunk: string): true { output.push(chunk); return true; } };
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const previousExitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await main({ argv, stdout });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = previousExitCode;
  return { output: output.join(""), exitCode };
}

function loggingStub(logFile: string, stdout = "{}") : string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return stubBin([
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${quote(logFile)}`,
    `printf '%s' ${quote(stdout)}`,
    "exit 0",
  ].join("\n"));
}

function readArgv(logFile: string): string[] {
  return existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean)
    : [];
}

describe("boolean literals before positionals", () => {
  it("logs tail --follow false <group> targets the group", async () => {
    const logFile = join(tmpdir(), `aws-axi-logs-follow-${Date.now()}.log`);
    const binary = loggingStub(logFile, "{\"events\":[]}");

    const { exitCode } = await captureMain(
      ["logs", "tail", "--follow", "false", LOG_GROUP],
      { PATH: `${stubDir(binary)}:${process.env.PATH ?? ""}` },
    );

    const argv = readArgv(logFile);
    expect(exitCode).toBeUndefined();
    expect(argv[argv.indexOf("--log-group-name") + 1]).toBe(LOG_GROUP);
  });

  it("wait --dry-run false ec2 instance-running resolves service and waiter", async () => {
    const logFile = join(tmpdir(), `aws-axi-wait-dry-run-${Date.now()}.log`);
    const binary = loggingStub(logFile);

    const { exitCode } = await captureMain(
      ["wait", "--dry-run", "false", "ec2", "instance-running", "--instance-ids", "i-123"],
      {
        PATH: `${stubDir(binary)}:${process.env.PATH ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(exitCode).toBeUndefined();
    expect(readArgv(logFile).slice(0, 3)).toEqual(["ec2", "wait", "instance-running"]);
  });

  it("whoami --debug false does not treat false as an argument", async () => {
    const binary = loggingStub(
      join(tmpdir(), `aws-axi-whoami-debug-${Date.now()}.log`),
      "{\"Account\":\"123456789012\",\"Arn\":\"arn:aws:iam::123456789012:user/test\",\"UserId\":\"AIDATEST\"}",
    );

    const { output, exitCode } = await captureMain(
      ["whoami", "--debug", "false"],
      { PATH: `${stubDir(binary)}:${process.env.PATH ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(output).toContain("123456789012");
  });

  it("preserves unknown Logs flag forwarding", async () => {
    const logFile = join(tmpdir(), `aws-axi-logs-passthrough-${Date.now()}.log`);
    const binary = loggingStub(logFile, "{\"events\":[]}");

    const { exitCode } = await captureMain(
      ["logs", "tail", LOG_GROUP, "--future-option", "opaque"],
      { PATH: `${stubDir(binary)}:${process.env.PATH ?? ""}` },
    );

    expect(exitCode).toBeUndefined();
    expect(readArgv(logFile)).toEqual(expect.arrayContaining(["--future-option", "opaque"]));
  });

  it("preserves wait usage errors when no service and waiter remain", async () => {
    const { output, exitCode } = await captureMain(
      ["wait", "--dry-run", "false"],
      { AWS_DATA_PATH: FIXTURES_DIR },
    );

    expect(exitCode).toBe(252);
    expect(output).toContain("requires <service> and <waiter-name>");
  });
});
