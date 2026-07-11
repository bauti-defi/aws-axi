/**
 * Tests for the resolve-policy primitive.
 * Uses real stub `aws` binaries — no mocks at the exec seam.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePolicy } from "../src/resolve/policy.js";
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
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-policy-"));
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

describe("resolvePolicy — ARN input", () => {
  it("extracts name from an AWS-managed policy ARN without a network call", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "should not be called",
      exitCode: 1,
    });
    const result = await resolvePolicy({
      nameOrArn: "arn:aws:iam::aws:policy/AdministratorAccess",
      binary: stub,
      _cache: new Map(),
    });
    expect(result.name).toBe("AdministratorAccess");
    expect(result.arn).toBe("arn:aws:iam::aws:policy/AdministratorAccess");
  });

  it("extracts name from a customer-managed policy ARN with a path", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "should not be called",
      exitCode: 1,
    });
    const result = await resolvePolicy({
      nameOrArn:
        "arn:aws:iam::123456789012:policy/service-role/MyCustomPolicy",
      binary: stub,
      _cache: new Map(),
    });
    expect(result.name).toBe("MyCustomPolicy");
    expect(result.arn).toBe(
      "arn:aws:iam::123456789012:policy/service-role/MyCustomPolicy",
    );
  });

  it("returns cached result on second call with same ARN", async () => {
    const stub = createStub({ stdout: "", stderr: "should not be called", exitCode: 1 });
    const cache = new Map();
    const arn = "arn:aws:iam::aws:policy/ReadOnlyAccess";

    const first = await resolvePolicy({ nameOrArn: arn, binary: stub, _cache: cache });
    const second = await resolvePolicy({ nameOrArn: arn, binary: stub, _cache: cache });

    expect(first).toEqual(second);
    expect(cache.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Name input — calls list-policies to find by name
// ---------------------------------------------------------------------------

describe("resolvePolicy — name input", () => {
  it("finds a policy by name via list-policies", async () => {
    const listJson = JSON.stringify({
      Policies: [
        {
          PolicyName: "MyPolicy",
          PolicyId: "ANPATEST",
          Arn: "arn:aws:iam::123456789012:policy/MyPolicy",
          Path: "/",
          AttachmentCount: 2,
          CreateDate: "2023-01-01T00:00:00+00:00",
          UpdateDate: "2023-06-01T00:00:00+00:00",
        },
      ],
    });
    const stub = createStub({ stdout: listJson, exitCode: 0 });

    const result = await resolvePolicy({
      nameOrArn: "MyPolicy",
      binary: stub,
      _cache: new Map(),
    });
    expect(result.name).toBe("MyPolicy");
    expect(result.arn).toBe("arn:aws:iam::123456789012:policy/MyPolicy");
  });

  it("throws SERVICE_CLIENT_ERROR when no policy matches the name", async () => {
    const listJson = JSON.stringify({
      Policies: [
        {
          PolicyName: "OtherPolicy",
          PolicyId: "ANPAOTHER",
          Arn: "arn:aws:iam::123456789012:policy/OtherPolicy",
          Path: "/",
          AttachmentCount: 0,
          CreateDate: "2023-01-01T00:00:00+00:00",
          UpdateDate: "2023-01-01T00:00:00+00:00",
        },
      ],
    });
    const stub = createStub({ stdout: listJson, exitCode: 0 });

    try {
      await resolvePolicy({
        nameOrArn: "NonExistentPolicy",
        binary: stub,
        _cache: new Map(),
      });
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect((e as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
      expect((e as AxiError).suggestions.length).toBeGreaterThan(0);
    }
  });

  it("caches the result after name lookup", async () => {
    const listJson = JSON.stringify({
      Policies: [
        {
          PolicyName: "CachedPolicy",
          PolicyId: "ANPACACHED",
          Arn: "arn:aws:iam::123456789012:policy/CachedPolicy",
          Path: "/",
          AttachmentCount: 1,
          CreateDate: "2023-01-01T00:00:00+00:00",
          UpdateDate: "2023-01-01T00:00:00+00:00",
        },
      ],
    });
    const successDir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-policy-hit-"));
    tempDirs.push(successDir);
    const successScript = join(successDir, "aws");
    writeFileSync(
      successScript,
      `#!/bin/sh\nprintf '%s' ${shellQuote(listJson)}\nexit 0`,
    );
    chmodSync(successScript, 0o755);

    const cache = new Map();
    const first = await resolvePolicy({
      nameOrArn: "CachedPolicy",
      binary: successScript,
      _cache: cache,
    });
    expect(first.name).toBe("CachedPolicy");

    // Second call should use cache
    const failStub = createStub({ stdout: "", stderr: "should not be called", exitCode: 1 });
    const second = await resolvePolicy({
      nameOrArn: "CachedPolicy",
      binary: failStub,
      _cache: cache,
    });
    expect(second).toEqual(first);
  });

  it("paginates through multiple pages to find a policy by name", async () => {
    // Page 1: does NOT contain the target — returns NextToken to signal more.
    const page1 = JSON.stringify({
      Policies: [
        {
          PolicyName: "OtherPolicy",
          PolicyId: "ANPAOTHER",
          Arn: "arn:aws:iam::123456789012:policy/OtherPolicy",
          Path: "/",
          AttachmentCount: 0,
          CreateDate: "2023-01-01T00:00:00+00:00",
          UpdateDate: "2023-01-01T00:00:00+00:00",
        },
      ],
      NextToken: "eyJhbGciOiJIUzI1NiJ9.page2-token",
    });

    // Page 2: contains the target — no NextToken (last page).
    const page2 = JSON.stringify({
      Policies: [
        {
          PolicyName: "TargetPolicy",
          PolicyId: "ANPATARGET",
          Arn: "arn:aws:iam::123456789012:policy/TargetPolicy",
          Path: "/",
          AttachmentCount: 3,
          CreateDate: "2023-01-01T00:00:00+00:00",
          UpdateDate: "2023-06-01T00:00:00+00:00",
        },
      ],
    });

    // Counting stub: first call → page 1, subsequent calls → page 2.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-policy-multi-"));
    tempDirs.push(dir);
    const countFile = join(dir, "count");
    const stub = join(dir, "aws");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `COUNT=$(cat "${countFile}" 2>/dev/null || echo 0)`,
        `echo $((COUNT + 1)) > "${countFile}"`,
        `if [ "$COUNT" = "0" ]; then`,
        `  printf '%s' ${shellQuote(page1)}`,
        "else",
        `  printf '%s' ${shellQuote(page2)}`,
        "fi",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const result = await resolvePolicy({
      nameOrArn: "TargetPolicy",
      binary: stub,
      _cache: new Map(),
    });

    expect(result.name).toBe("TargetPolicy");
    expect(result.arn).toBe("arn:aws:iam::123456789012:policy/TargetPolicy");
  });
});
