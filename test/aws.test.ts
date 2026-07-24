/**
 * Exec-seam tests against a REAL subprocess boundary.
 * We do NOT mock execFile or child_process — instead we create real stub
 * shell scripts and pass their path as the `binary` option. The full OS
 * process is spawned; this proves the seam works at an actual process
 * boundary without requiring live AWS credentials.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { awsRaw, awsJson, awsExec } from "../src/aws.js";
import { AxiError } from "axi-sdk-js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

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

  const scriptPath = stubBin(lines);
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
    // Inject a nonexistent configPath so enrichment never reads the developer's real
    // ~/.aws/config — ADR-0003 requires all tests to be config-file-isolated.
    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: stub,
      configPath: "/nonexistent/path/.aws/config",
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
    const scriptPath = stubBin(`#!/bin/sh\necho "$@"\nexit 0`);

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: scriptPath,
    });
    expect(result.stdout).toContain("--output");
    expect(result.stdout).toContain("json");
  });

  it("sets AWS_PROFILE env var when context has profile", async () => {
    // Print the AWS_PROFILE env var that the child sees
    const scriptPath = stubBin(`#!/bin/sh\necho "$AWS_PROFILE"\nexit 0`);

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: scriptPath,
      context: { profile: "my-profile", region: undefined },
    });
    expect(result.stdout.trim()).toBe("my-profile");
  });

  it("sets AWS_DEFAULT_REGION env var when context has region", async () => {
    const scriptPath = stubBin(`#!/bin/sh\necho "$AWS_DEFAULT_REGION"\nexit 0`);

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: scriptPath,
      context: { profile: undefined, region: "eu-west-1" },
    });
    expect(result.stdout.trim()).toBe("eu-west-1");
  });

  // ── Structural enrichment (result.error field) ──────────────────────────────
  //
  // These tests are the behavioral proof of the #72 structural fix.
  // awsRaw must populate result.error with the parsed+enriched ParsedAwsError
  // on every non-zero exit, so NO consumer can bypass enrichment by failing to
  // call parseAndEnrichAwsError — the correct error is already in the result.

  it("populates result.error with NO_CREDENTIALS on credential failure (no named profiles)", async () => {
    const stub = createStub({
      stderr: "Unable to locate credentials",
      exitCode: 253,
    });
    // Inject a nonexistent configPath so enrichment finds no profiles → stays NO_CREDENTIALS
    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: stub,
      configPath: "/nonexistent/path/.aws/config",
    });
    expect(result.exitCode).toBe(253);
    // error must be present and carry the enriched classification
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("NO_CREDENTIALS");
  });

  it("populates result.error with NO_PROFILE_SELECTED when named profiles exist but no profile was selected", async () => {
    // Write a fake ~/.aws/config with a named profile so enrichment can upgrade
    const tmpDir = mkdtempSync(join(tmpdir(), "aws-axi-cfg-"));
    const configPath = join(tmpDir, "config");
    writeFileSync(
      configPath,
      "[profile dev]\nregion = us-east-1\n[profile prod]\nregion = eu-west-1\n",
    );

    const stub = createStub({
      stderr: "Unable to locate credentials",
      exitCode: 253,
    });

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: stub,
      configPath,
    });

    expect(result.exitCode).toBe(253);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("NO_PROFILE_SELECTED");
    // Profile names must appear in suggestions so the agent / user can act on them
    const suggestions = result.error!.suggestions.join(" ");
    expect(suggestions).toContain("dev");
    expect(suggestions).toContain("prod");

    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });

  it("result.error is undefined when exit code is 0 (success)", async () => {
    const stub = createStub({ stdout: '{"ok":true}', exitCode: 0 });
    const result = await awsRaw(["sts", "get-caller-identity"], { binary: stub });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("populates result.error with SERVICE_CLIENT_ERROR on botocore errors", async () => {
    const stub = createStub({
      stderr: "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: Access Denied",
      exitCode: 254,
    });
    const result = await awsRaw(["sts", "get-caller-identity"], { binary: stub });
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("SERVICE_CLIENT_ERROR");
    expect(result.error!.botoCode).toBe("AccessDenied");
    expect(result.error!.operation).toBe("GetCallerIdentity");
  });

  it("result.error enrichment respects context.profile — skips upgrade when profile was selected", async () => {
    // When a profile was already selected (context.profile is set), NO_CREDENTIALS
    // must NOT be upgraded to NO_PROFILE_SELECTED even if named profiles exist.
    const tmpDir = mkdtempSync(join(tmpdir(), "aws-axi-cfg-"));
    const configPath = join(tmpDir, "config");
    writeFileSync(configPath, "[profile dev]\nregion = us-east-1\n");

    const stub = createStub({
      stderr: "Unable to locate credentials",
      exitCode: 253,
    });

    const result = await awsRaw(["sts", "get-caller-identity"], {
      binary: stub,
      context: { profile: "dev", region: undefined },
      configPath,
    });

    expect(result.error).toBeDefined();
    // Profile was selected — error stays NO_CREDENTIALS (the profile itself has no valid creds)
    expect(result.error!.code).toBe("NO_CREDENTIALS");

    rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Cross-surface agreement — awsRaw / awsExec / awsJson must classify identically
// ---------------------------------------------------------------------------
//
// This is the behavioral proof of blocker-2's fix (PR #79 review).
// awsExec and awsJson route through awsRaw; a future enrichment added inside
// awsRaw therefore reaches all three surfaces without additional wiring.
// Any divergence here means the consolidation has been broken.

describe("cross-surface classification agreement — awsRaw / awsExec / awsJson", () => {
  const NO_CREDS_STDERR = "Unable to locate credentials";
  const ACCESS_DENIED_STDERR =
    "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: Access Denied";
  const DRY_RUN_STDERR =
    "An error occurred (DryRunOperation) when calling the RunInstances operation: Request would have succeeded.";

  it("awsRaw and awsExec agree on NO_CREDENTIALS code for identical stderr", async () => {
    const rawStub = createStub({ stderr: NO_CREDS_STDERR, exitCode: 253 });
    const execStub = createStub({ stderr: NO_CREDS_STDERR, exitCode: 253 });

    const rawResult = await awsRaw(["sts", "get-caller-identity"], {
      binary: rawStub,
      configPath: "/nonexistent/path/.aws/config",
    });

    let execCode: string | undefined;
    try {
      await awsExec(["sts", "get-caller-identity"], {
        binary: execStub,
        configPath: "/nonexistent/path/.aws/config",
      });
    } catch (e) {
      execCode = (e as { code?: string }).code;
    }

    expect(rawResult.error?.code).toBe("NO_CREDENTIALS");
    expect(execCode).toBe(rawResult.error?.code);
  });

  it("awsRaw and awsJson agree on NO_CREDENTIALS code for identical stderr", async () => {
    const rawStub = createStub({ stderr: NO_CREDS_STDERR, exitCode: 253 });
    const jsonStub = createStub({ stderr: NO_CREDS_STDERR, exitCode: 253 });

    const rawResult = await awsRaw(["sts", "get-caller-identity"], {
      binary: rawStub,
      configPath: "/nonexistent/path/.aws/config",
    });

    let jsonCode: string | undefined;
    try {
      await awsJson(["sts", "get-caller-identity"], {
        binary: jsonStub,
        configPath: "/nonexistent/path/.aws/config",
      });
    } catch (e) {
      jsonCode = (e as { code?: string }).code;
    }

    expect(rawResult.error?.code).toBe("NO_CREDENTIALS");
    expect(jsonCode).toBe(rawResult.error?.code);
  });

  it("awsRaw, awsExec, awsJson agree on SERVICE_CLIENT_ERROR for ACCESS_DENIED", async () => {
    const stubs = [1, 2, 3].map(() =>
      createStub({ stderr: ACCESS_DENIED_STDERR, exitCode: 254 }),
    );

    const rawResult = await awsRaw(["sts", "get-caller-identity"], {
      binary: stubs[0]!,
      configPath: "/nonexistent/path/.aws/config",
    });

    const codes: string[] = [];
    for (const stub of [stubs[1]!, stubs[2]!]) {
      try {
        // awsExec first, awsJson second
        if (stub === stubs[1]) {
          await awsExec(["sts", "get-caller-identity"], { binary: stub, configPath: "/nonexistent/path/.aws/config" });
        } else {
          await awsJson(["sts", "get-caller-identity"], { binary: stub, configPath: "/nonexistent/path/.aws/config" });
        }
      } catch (e) {
        codes.push((e as { code?: string }).code ?? "");
      }
    }

    expect(rawResult.error?.code).toBe("SERVICE_CLIENT_ERROR");
    expect(codes).toEqual(["SERVICE_CLIENT_ERROR", "SERVICE_CLIENT_ERROR"]);
  });

  it("DRY_RUN_SUCCESS: awsRaw exposes it in result.error, awsJson returns {} (by design)", async () => {
    const rawStub = createStub({ stderr: DRY_RUN_STDERR, exitCode: 255 });
    const jsonStub = createStub({ stderr: DRY_RUN_STDERR, exitCode: 255 });

    const rawResult = await awsRaw(["ec2", "run-instances", "--dry-run"], {
      binary: rawStub,
      configPath: "/nonexistent/path/.aws/config",
    });
    // awsRaw surfaces DRY_RUN_SUCCESS in result.error (non-zero exit — it IS an error at the process level)
    expect(rawResult.error?.code).toBe("DRY_RUN_SUCCESS");

    // awsJson translates DRY_RUN_SUCCESS into an empty-object success return — by design
    const jsonResult = await awsJson(["ec2", "run-instances", "--dry-run"], {
      binary: jsonStub,
      configPath: "/nonexistent/path/.aws/config",
    });
    expect(jsonResult).toEqual({});
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

  it("throws AxiError with NO_CREDENTIALS on credentials error (no profiles in config)", async () => {
    // Inject a nonexistent configPath so the enrichment finds no named profiles
    // and keeps the error as NO_CREDENTIALS — regression guard for the empty-config path.
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    await expect(
      awsJson(["sts", "get-caller-identity"], {
        binary: stub,
        configPath: "/nonexistent/path/to/.aws/config",
      }),
    ).rejects.toBeInstanceOf(AxiError);

    try {
      const stub2 = createStub({
        stdout: "",
        stderr: "Unable to locate credentials",
        exitCode: 255,
      });
      await awsJson(["sts", "get-caller-identity"], {
        binary: stub2,
        configPath: "/nonexistent/path/to/.aws/config",
      });
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
