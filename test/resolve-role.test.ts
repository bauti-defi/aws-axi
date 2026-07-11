/**
 * Tests for the resolve-role primitive.
 * Uses real stub `aws` binaries — no mocks at the exec seam.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRole } from "../src/resolve/role.js";
import { AxiError } from "axi-sdk-js";

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-role-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const lines = [
    "#!/bin/sh",
    spec.stdout !== undefined ? `printf '%s' ${shellQuote(spec.stdout)}` : "",
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
// ARN input — name parsed from ARN, no network call needed
// ---------------------------------------------------------------------------

describe("resolveRole — ARN input", () => {
  it("extracts name from a simple role ARN without a network call", async () => {
    // Stub that fails if called — proves no network call is made for ARN input
    const stub = createStub({ stdout: "", stderr: "should not be called", exitCode: 1 });
    const result = await resolveRole({
      nameOrArn: "arn:aws:iam::123456789012:role/my-role",
      binary: stub,
      _cache: new Map(),
    });
    expect(result.name).toBe("my-role");
    expect(result.arn).toBe("arn:aws:iam::123456789012:role/my-role");
  });

  it("extracts name from a role ARN with a path", async () => {
    const stub = createStub({ stdout: "", stderr: "should not be called", exitCode: 1 });
    const result = await resolveRole({
      nameOrArn: "arn:aws:iam::123456789012:role/service-role/my-task-role",
      binary: stub,
      _cache: new Map(),
    });
    expect(result.name).toBe("my-task-role");
    expect(result.arn).toBe(
      "arn:aws:iam::123456789012:role/service-role/my-task-role",
    );
  });

  it("returns cached result on second call with same ARN", async () => {
    let callCount = 0;
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-role-cache-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(p, `#!/bin/sh\necho "call $((callCount++))" >&2\nexit 1`);
    chmodSync(p, 0o755);

    const cache = new Map();
    const arn = "arn:aws:iam::123456789012:role/cached-role";

    const first = await resolveRole({ nameOrArn: arn, binary: p, _cache: cache });
    const second = await resolveRole({ nameOrArn: arn, binary: p, _cache: cache });
    expect(first).toEqual(second);
    expect(cache.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Name input — calls get-role
// ---------------------------------------------------------------------------

describe("resolveRole — name input", () => {
  it("calls get-role and returns name + arn from API response", async () => {
    const roleJson = JSON.stringify({
      Role: {
        RoleName: "my-role",
        RoleId: "AROATEST",
        Arn: "arn:aws:iam::123456789012:role/my-role",
        CreateDate: "2023-01-01T00:00:00+00:00",
        Path: "/",
        AssumeRolePolicyDocument: {},
        MaxSessionDuration: 3600,
      },
    });
    const stub = createStub({ stdout: roleJson, exitCode: 0 });

    const result = await resolveRole({
      nameOrArn: "my-role",
      binary: stub,
      _cache: new Map(),
    });

    expect(result.name).toBe("my-role");
    expect(result.arn).toBe("arn:aws:iam::123456789012:role/my-role");
  });

  it("throws SERVICE_CLIENT_ERROR when role not found", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (NoSuchEntityException) when calling the GetRole operation: Role not found: nonexistent",
      exitCode: 254,
    });

    await expect(
      resolveRole({ nameOrArn: "nonexistent", binary: stub, _cache: new Map() }),
    ).rejects.toBeInstanceOf(AxiError);

    const stub2 = createStub({
      stdout: "",
      stderr:
        "An error occurred (NoSuchEntityException) when calling the GetRole operation: Role not found: nonexistent",
      exitCode: 254,
    });

    try {
      await resolveRole({ nameOrArn: "nonexistent", binary: stub2, _cache: new Map() });
    } catch (e) {
      expect((e as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    }
  });

  it("caches the result after first lookup", async () => {
    const roleJson = JSON.stringify({
      Role: {
        RoleName: "cached-role",
        RoleId: "AROATEST2",
        Arn: "arn:aws:iam::123456789012:role/cached-role",
        CreateDate: "2023-01-01T00:00:00+00:00",
        Path: "/",
        AssumeRolePolicyDocument: {},
        MaxSessionDuration: 3600,
      },
    });
    // A stub that succeeds the first time, fails the second (proves caching)
    const successDir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-role-hit-"));
    tempDirs.push(successDir);
    const successScript = join(successDir, "aws");
    writeFileSync(successScript, `#!/bin/sh\nprintf '%s' ${shellQuote(roleJson)}\nexit 0`);
    chmodSync(successScript, 0o755);

    const cache = new Map();
    const first = await resolveRole({
      nameOrArn: "cached-role",
      binary: successScript,
      _cache: cache,
    });
    expect(first.name).toBe("cached-role");

    // Second call uses cache — binary doesn't matter
    const failStub = createStub({ stdout: "", stderr: "should not be called", exitCode: 1 });
    const second = await resolveRole({
      nameOrArn: "cached-role",
      binary: failStub,
      _cache: cache,
    });
    expect(second).toEqual(first);
  });
});
