/**
 * E2E tests for the whoami command through a real stub aws binary.
 * No mocks — the full `awsJson` exec seam runs with a subprocess boundary.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { whoamiRun } from "../src/commands/whoami.js";
import { AxiError } from "axi-sdk-js";

const tempDirs: string[] = [];

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-whoami-"));
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

// ---------------------------------------------------------------------------
// The fused TOON block (happy path)
// ---------------------------------------------------------------------------

describe("whoamiRun — happy path", () => {
  it("returns the fused identity+context object", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"123456789012","UserId":"AIDAJQABLCHTEST","Arn":"arn:aws:iam::123456789012:user/test-user"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: { profile: "my-profile", region: "us-west-2" },
      binary: stub,
    });

    expect(result).toMatchObject({
      whoami: {
        account: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test-user",
        userId: "AIDAJQABLCHTEST",
        profile: "my-profile",
        region: "us-west-2",
      },
    });
  });

  it("falls back to 'default' profile when none specified", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"999999999999","UserId":"AIDATEST","Arn":"arn:aws:iam::999999999999:user/nobody"}',
      exitCode: 0,
    });

    const result = await whoamiRun({ context: undefined, binary: stub });

    // Profile not specified in context → falls back to "default"
    expect(result.whoami.profile).toBe("default");
  });

  it("includes a credentialSource field", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"123456789012","UserId":"AIDATEST","Arn":"arn:aws:iam::123456789012:user/test"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: { profile: "prod", region: "us-east-1" },
      binary: stub,
    });

    expect(result.whoami.credentialSource).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Credential error paths
// ---------------------------------------------------------------------------

describe("whoamiRun — credential errors", () => {
  it("throws AxiError with NO_CREDENTIALS for missing credentials", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    await expect(
      whoamiRun({ context: undefined, binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);

    const stub2 = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    try {
      await whoamiRun({ context: undefined, binary: stub2 });
    } catch (e) {
      expect((e as AxiError).code).toBe("NO_CREDENTIALS");
      expect(
        (e as AxiError).suggestions.some((s) => s.includes("sso login")),
      ).toBe(true);
    }
  });

  it("throws AxiError with AUTH_EXPIRED for expired token", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: The security token included in the request is expired",
      exitCode: 255,
    });

    try {
      await whoamiRun({ context: undefined, binary: stub });
    } catch (e) {
      expect((e as AxiError).code).toBe("AUTH_EXPIRED");
      expect(
        (e as AxiError).suggestions.some((s) => s.includes("sso login")),
      ).toBe(true);
    }
  });
});
