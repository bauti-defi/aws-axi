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

  it("does not swallow ssm start-session --help in the generic signature renderer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeEcsModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output } = await captureMain(
      ["ssm", "start-session", "--help"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    expect(output).not.toContain("aws-axi ssm start-session");
    expect(output).not.toContain("usage: aws-axi ssm");
    expect(existsSync(marker)).toBe(true);
  });
});

describe("operation help — custom ops keep their own --help branch", () => {
  function writeLoginPasswordModel(root: string): void {
    const versionDir = join(root, "ecr", "2015-09-21");
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(versionDir, "service-2.json"),
      JSON.stringify({
        version: "2.0",
        metadata: { apiVersion: "2015-09-21", serviceId: "ECR" },
        operations: {
          GetLoginPassword: {
            name: "GetLoginPassword",
            input: { shape: "GetLoginPasswordRequest" },
            output: { shape: "GetLoginPasswordResponse" },
          },
        },
        shapes: {
          GetLoginPasswordRequest: {
            type: "structure",
            members: { RegistryId: { shape: "StringType" } },
          },
          GetLoginPasswordResponse: {
            type: "structure",
            members: { Password: { shape: "StringType" } },
          },
          StringType: { type: "string" },
        },
      }),
      "utf8",
    );
  }

  it("does not render a botocore signature for ecr get-login-password --help", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeLoginPasswordModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output } = await captureMain(
      ["ecr", "get-login-password", "--help"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    // The fixture operation exists, so the generic renderer would print this
    // signature and exit without calling aws. Skipping the intercept lets the
    // custom-op branch (or, until that branch is merged, the engine) run.
    expect(output).not.toContain("aws-axi ecr get-login-password");
    expect(output).not.toContain("--registry-id");
    expect(existsSync(marker)).toBe(true);
  });

  it("does not render a botocore signature for ecr get-login-password -h", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeLoginPasswordModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);

    const { output } = await captureMain(
      ["ecr", "get-login-password", "-h"],
      {
        PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: dir,
      },
    );

    expect(output).not.toContain("aws-axi ecr get-login-password");
    expect(output).not.toContain("--registry-id");
    expect(existsSync(marker)).toBe(true);
  });
});

describe("operation help — invented confidentiality flags stay visible", () => {
  function writeOpModel(
    root: string,
    service: string,
    operations: Readonly<Record<string, { readonly members: Readonly<Record<string, string>> }>>,
  ): void {
    const versionDir = join(root, service, "2017-10-17");
    mkdirSync(versionDir, { recursive: true });
    const shapes: Record<string, unknown> = { StringType: { type: "string" } };
    const ops: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(operations)) {
      const request = `${name}Request`;
      shapes[request] = {
        type: "structure",
        members: Object.fromEntries(
          Object.keys(spec.members).map((member) => [member, { shape: "StringType" }]),
        ),
      };
      ops[name] = {
        name,
        input: { shape: request },
        output: { shape: "StringType" },
      };
    }
    writeFileSync(
      join(versionDir, "service-2.json"),
      JSON.stringify({
        version: "2.0",
        metadata: { apiVersion: "2017-10-17", serviceId: service },
        operations: ops,
        shapes,
      }),
      "utf8",
    );
  }

  async function helpFor(argv: string[], model: (root: string) => void): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    model(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);
    const { output, exitCode } = await captureMain(argv, {
      PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
      AWS_DATA_PATH: dir,
    });
    expect(exitCode).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    return output;
  }

  it("secretsmanager get-secret-value --help documents --reveal and --raw", async () => {
    const output = await helpFor(
      ["secretsmanager", "get-secret-value", "--help"],
      (root) =>
        writeOpModel(root, "secretsmanager", {
          GetSecretValue: { members: { SecretId: "string" } },
        }),
    );

    expect(output).toContain("--secret-id");
    expect(output).toContain("--reveal");
    expect(output).toContain("--raw");
    expect(output).toContain("Requires --reveal");
  });

  it("batch-get-secret-value --help documents --reveal but not --raw", async () => {
    const output = await helpFor(
      ["secretsmanager", "batch-get-secret-value", "--help"],
      (root) =>
        writeOpModel(root, "secretsmanager", {
          BatchGetSecretValue: { members: { SecretIdList: "string" } },
        }),
    );

    expect(output).toContain("--reveal");
    expect(output).not.toContain("--raw");
  });

  it("ssm get-parameter --help documents --reveal and keeps the botocore param", async () => {
    const output = await helpFor(
      ["ssm", "get-parameter", "--help"],
      (root) =>
        writeOpModel(root, "ssm", {
          GetParameter: { members: { Name: "string", WithDecryption: "string" } },
        }),
    );

    expect(output).toContain("--name");
    expect(output).toContain("--with-decryption");
    expect(output).toContain("--reveal");
    expect(output).not.toContain("--raw");
  });

  it("does not invent --reveal on an operation that does not honor it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-op-help-"));
    tempDirs.push(dir);
    writeEcsModel(dir);
    const marker = join(dir, "aws-invoked");
    const binary = bannerStub(marker);
    const { output, exitCode } = await captureMain(["ecs", "list-tasks", "--help"], {
      PATH: `${stubDir(binary)}:${process.env["PATH"] ?? ""}`,
      AWS_DATA_PATH: dir,
    });

    expect(exitCode).toBeUndefined();
    expect(output).toContain("--cluster");
    expect(output).not.toContain("--reveal");
    expect(output).not.toContain("aws-axi flags:");
    expect(existsSync(marker)).toBe(false);
  });
});

