/**
 * Exec-seam tests against a REAL subprocess boundary.
 * We do NOT mock execFile or child_process — instead we create real stub
 * shell scripts and pass their path as the `binary` option. The full OS
 * process is spawned; this proves the seam works at an actual process
 * boundary without requiring live AWS credentials.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { awsRaw, awsJson, awsExec } from "../src/aws.js";
import { AxiError } from "axi-sdk-js";

// ---------------------------------------------------------------------------
// Stub factory — creates a real executable shell script in a temp dir.
// ---------------------------------------------------------------------------

interface StubSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const tempDirs: string[] = [];

function createStub(spec: StubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-stub-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "aws");

  // Use printf with JSON.stringify to safely embed arbitrary strings.
  // JSON.stringify wraps the value in double-quotes and escapes internal
  // double-quotes, backslashes, etc. The printf format string '%s' prevents
  // printf from interpreting escape sequences in the data.
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

  writeFileSync(scriptPath, lines);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Single-quote-escape a string for safe shell embedding. */
function shellQuote(s: string): string {
  // Replace each single-quote with '\'' (end quote, literal ', re-open quote)
  return `'${s.replaceAll("'", "'\\''")}'`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// awsRaw — low-level, never throws on non-zero exit
// ---------------------------------------------------------------------------

describe("awsRaw", () => {
  it("returns stdout, stderr, and exitCode=0 on success", async () => {
    const stub = createStub({
      stdout: '{"Account":"123456789012"}',
      stderr: "",
      exitCode: 0,
    });
    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: stub,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("123456789012");
    expect(result.stderr).toBe("");
  });

  it("returns non-zero exitCode without throwing", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: stub,
    });
    expect(result.exitCode).toBe(255);
    expect(result.stderr).toContain("Unable to locate credentials");
  });

  it("throws AxiError with AWS_NOT_INSTALLED when binary is missing", async () => {
    await expect(
      awsRaw(["sts", "get-caller-identity"], {
        binary: "/nonexistent/path/to/aws",
      }),
    ).rejects.toBeInstanceOf(AxiError);

    try {
      await awsRaw(["sts", "get-caller-identity"], {
        binary: "/nonexistent/path/to/aws",
      });
    } catch (e) {
      expect((e as AxiError).code).toBe("AWS_NOT_INSTALLED");
    }
  });

  it("appends --output json to every invocation", async () => {
    // Stub that echoes its args to stdout so we can inspect them
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-stub-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "aws");
    writeFileSync(scriptPath, `#!/bin/sh\necho "$@"\nexit 0`);
    chmodSync(scriptPath, 0o755);

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: scriptPath,
    });
    expect(result.stdout).toContain("--output");
    expect(result.stdout).toContain("json");
  });

  it("sets AWS_PROFILE env var when context has profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-stub-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "aws");
    // Print the AWS_PROFILE env var that the child sees
    writeFileSync(scriptPath, `#!/bin/sh\necho "$AWS_PROFILE"\nexit 0`);
    chmodSync(scriptPath, 0o755);

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: scriptPath,
      context: { profile: "my-profile", region: undefined },
    });
    expect(result.stdout.trim()).toBe("my-profile");
  });

  it("sets AWS_DEFAULT_REGION env var when context has region", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-stub-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "aws");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\necho "$AWS_DEFAULT_REGION"\nexit 0`,
    );
    chmodSync(scriptPath, 0o755);

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: scriptPath,
      context: { profile: undefined, region: "eu-west-1" },
    });
    expect(result.stdout.trim()).toBe("eu-west-1");
  });
});

// ---------------------------------------------------------------------------
// awsJson — parses stdout as JSON, throws on non-zero exit
// ---------------------------------------------------------------------------

describe("awsJson", () => {
  it("parses JSON stdout on success", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"123456789012","UserId":"AIDATEST","Arn":"arn:aws:iam::123456789012:user/test"}',
      exitCode: 0,
    });
    const result = await awsJson<{
      Account: string;
      UserId: string;
      Arn: string;
    }>(["sts", "get-caller-identity"], { binary: stub });
    expect(result.Account).toBe("123456789012");
    expect(result.UserId).toBe("AIDATEST");
    expect(result.Arn).toBe("arn:aws:iam::123456789012:user/test");
  });

  it("throws AxiError with NO_CREDENTIALS on credentials error", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    await expect(
      awsJson(["sts", "get-caller-identity"], { binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);

    try {
      const stub2 = createStub({
        stdout: "",
        stderr: "Unable to locate credentials",
        exitCode: 255,
      });
      await awsJson(["sts", "get-caller-identity"], { binary: stub2 });
    } catch (e) {
      expect((e as AxiError).code).toBe("NO_CREDENTIALS");
    }
  });

  it("throws AxiError with SERVICE_CLIENT_ERROR on AccessDenied", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: forbidden",
      exitCode: 255,
    });

    try {
      await awsJson(["sts", "get-caller-identity"], { binary: stub });
    } catch (e) {
      expect((e as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    }
  });

  it("returns empty object for DryRunOperation (success signal)", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (DryRunOperation) when calling the RunInstances operation: Request would have succeeded, but DryRun flag is set.",
      exitCode: 255,
    });
    const result = await awsJson(["ec2", "run-instances", "--dry-run"], {
      binary: stub,
    });
    expect(result).toEqual({});
  });

  it("throws AxiError with UNKNOWN on invalid JSON output", async () => {
    const stub = createStub({ stdout: "not valid json", exitCode: 0 });

    try {
      await awsJson(["sts", "get-caller-identity"], { binary: stub });
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect((e as AxiError).code).toBe("UNKNOWN");
      expect((e as AxiError).message).toContain("Unexpected aws output");
    }
  });
});

// ---------------------------------------------------------------------------
// awsExec — returns raw stdout string
// ---------------------------------------------------------------------------

describe("awsExec", () => {
  it("returns stdout as a string on success", async () => {
    const stub = createStub({ stdout: "some raw output\n", exitCode: 0 });
    const result = await awsExec(["s3", "ls"], { binary: stub });
    expect(result).toBe("some raw output\n");
  });

  it("throws AxiError on non-zero exit", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    await expect(
      awsExec(["s3", "ls"], { binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);
  });
});
