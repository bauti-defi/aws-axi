/**
 * E2E tests for the iam command through a real stub aws binary.
 * No mocks — the full `awsJson` exec seam runs with a subprocess boundary.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { iamRun } from "../src/commands/iam.js";
import { AxiError } from "axi-sdk-js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
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
  const p = stubBin(lines);
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
// Fixtures
// ---------------------------------------------------------------------------

// Fixtures use the real shape the AWS CLI emits under --max-items:
//   non-truncated: { <ResultKey>: [...] }            — no IsTruncated, no NextToken
//   truncated:     { <ResultKey>: [...], NextToken: "<base64>" } — synthesised by botocore
// IsTruncated / Marker are stripped by the CLI's client-side paginator and
// must NOT appear in any fixture here.

const LIST_ROLES_PAGE1 = JSON.stringify({
  Roles: [
    {
      RoleName: "role-a",
      RoleId: "AROAAAA",
      Arn: "arn:aws:iam::123456789012:role/role-a",
      CreateDate: "2023-01-01T00:00:00+00:00",
      Path: "/",
      MaxSessionDuration: 3600,
    },
    {
      RoleName: "role-b",
      RoleId: "AROABBB",
      Arn: "arn:aws:iam::123456789012:role/role-b",
      CreateDate: "2023-06-01T00:00:00+00:00",
      Path: "/",
      Description: "Service role",
      MaxSessionDuration: 7200,
    },
  ],
});

// Real truncated shape: NextToken present, IsTruncated absent.
const LIST_ROLES_TRUNCATED = JSON.stringify({
  Roles: [
    {
      RoleName: "role-a",
      RoleId: "AROAAAA",
      Arn: "arn:aws:iam::123456789012:role/role-a",
      CreateDate: "2023-01-01T00:00:00+00:00",
      Path: "/",
      MaxSessionDuration: 3600,
    },
  ],
  NextToken: "eyJhbGciOiJIUzI1NiJ9.next-page-token",
});

const GET_ROLE_RESPONSE = JSON.stringify({
  Role: {
    RoleName: "my-role",
    RoleId: "AROATESTEXAMPLE",
    Arn: "arn:aws:iam::123456789012:role/my-role",
    CreateDate: "2023-03-15T12:00:00+00:00",
    Path: "/",
    Description: "My test role",
    MaxSessionDuration: 3600,
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
    },
    Tags: [{ Key: "Environment", Value: "test" }],
  },
});

const LIST_POLICIES_RESPONSE = JSON.stringify({
  Policies: [
    {
      PolicyName: "AdministratorAccess",
      PolicyId: "ANPATEST1",
      Arn: "arn:aws:iam::aws:policy/AdministratorAccess",
      Path: "/",
      DefaultVersionId: "v1",
      AttachmentCount: 5,
      IsAttachable: true,
      CreateDate: "2015-02-06T18:39:46+00:00",
      UpdateDate: "2023-01-01T00:00:00+00:00",
    },
    {
      PolicyName: "ReadOnlyAccess",
      PolicyId: "ANPATEST2",
      Arn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
      Path: "/",
      DefaultVersionId: "v17",
      AttachmentCount: 2,
      IsAttachable: true,
      CreateDate: "2015-02-06T18:39:47+00:00",
      UpdateDate: "2023-06-01T00:00:00+00:00",
    },
  ],
});

const LIST_POLICIES_TRUNCATED = JSON.stringify({
  Policies: [
    {
      PolicyName: "AdministratorAccess",
      PolicyId: "ANPATEST1",
      Arn: "arn:aws:iam::aws:policy/AdministratorAccess",
      Path: "/",
      DefaultVersionId: "v1",
      AttachmentCount: 5,
      IsAttachable: true,
      CreateDate: "2015-02-06T18:39:46+00:00",
      UpdateDate: "2023-01-01T00:00:00+00:00",
    },
  ],
  NextToken: "eyJhbGciOiJIUzI1NiJ9.policy-next-token",
});

const GET_POLICY_RESPONSE = JSON.stringify({
  Policy: {
    PolicyName: "AdministratorAccess",
    PolicyId: "ANPATEST1",
    Arn: "arn:aws:iam::aws:policy/AdministratorAccess",
    Path: "/",
    DefaultVersionId: "v1",
    AttachmentCount: 5,
    IsAttachable: true,
    CreateDate: "2015-02-06T18:39:46+00:00",
    UpdateDate: "2023-01-01T00:00:00+00:00",
  },
});

const LIST_ATTACHED_POLICIES_RESPONSE = JSON.stringify({
  AttachedPolicies: [
    {
      PolicyName: "AdministratorAccess",
      PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    },
    {
      PolicyName: "CloudWatchReadOnlyAccess",
      PolicyArn: "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess",
    },
  ],
});

const LIST_ATTACHED_POLICIES_TRUNCATED = JSON.stringify({
  AttachedPolicies: [
    {
      PolicyName: "AdministratorAccess",
      PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
    },
  ],
  NextToken: "eyJhbGciOiJIUzI1NiJ9.attached-next-token",
});

// ---------------------------------------------------------------------------
// list-roles
// ---------------------------------------------------------------------------

describe("iamRun — list-roles", () => {
  it("returns curated roles with name, arn, id, created", async () => {
    const stub = createStub({ stdout: LIST_ROLES_PAGE1, exitCode: 0 });
    const result = await iamRun({ op: "list-roles", args: [], binary: stub });

    expect(result).toHaveProperty("roles");
    const roles = result["roles"] as Array<Record<string, unknown>>;
    expect(roles).toHaveLength(2);

    const first = roles[0]!;
    expect(first["name"]).toBe("role-a");
    expect(first["arn"]).toBe("arn:aws:iam::123456789012:role/role-a");
    expect(first["id"]).toBe("AROAAAA");
    expect(first["created"]).toBe("2023-01-01T00:00:00+00:00");

    // Raw AWS noise is NOT included
    expect(first).not.toHaveProperty("Path");
    expect(first).not.toHaveProperty("AssumeRolePolicyDocument");
  });

  it("includes a count field", async () => {
    const stub = createStub({ stdout: LIST_ROLES_PAGE1, exitCode: 0 });
    const result = await iamRun({ op: "list-roles", args: [], binary: stub });
    expect(result["count"]).toBe(2);
  });

  it("reports truncation with next-token when NextToken is present", async () => {
    const stub = createStub({ stdout: LIST_ROLES_TRUNCATED, exitCode: 0 });
    const result = await iamRun({ op: "list-roles", args: [], binary: stub });

    expect(result["truncated"]).toBe(true);
    expect(result["nextToken"]).toBe("eyJhbGciOiJIUzI1NiJ9.next-page-token");
    const help = result["help"] as string[];
    // Must include a resume command the agent can copy-paste
    expect(help.some((h) => h.includes("--next-token"))).toBe(true);
  });

  it("returns definitive empty state with a suggestion when no roles exist", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ Roles: [] }),
      exitCode: 0,
    });
    const result = await iamRun({ op: "list-roles", args: [], binary: stub });

    expect(result["roles"]).toEqual([]);
    expect(result["count"]).toBe(0);
    expect(result["help"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// get-role
// ---------------------------------------------------------------------------

describe("iamRun — get-role", () => {
  it("returns curated role projection", async () => {
    const stub = createStub({ stdout: GET_ROLE_RESPONSE, exitCode: 0 });
    const result = await iamRun({
      op: "get-role",
      args: ["my-role"],
      binary: stub,
    });

    expect(result).toHaveProperty("role");
    const role = result["role"] as Record<string, unknown>;
    expect(role["name"]).toBe("my-role");
    expect(role["arn"]).toBe("arn:aws:iam::123456789012:role/my-role");
    expect(role["id"]).toBe("AROATESTEXAMPLE");
    expect(role["created"]).toBe("2023-03-15T12:00:00+00:00");
    expect(role["description"]).toBe("My test role");
    expect(role["maxSessionDuration"]).toBe(3600);

    // Raw noise not included
    expect(role).not.toHaveProperty("AssumeRolePolicyDocument");
    expect(role).not.toHaveProperty("Tags");
    expect(role).not.toHaveProperty("Path");
  });

  it("throws USAGE_ERROR when role name is missing", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });
    try {
      await iamRun({ op: "get-role", args: [], binary: stub });
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect((e as AxiError).code).toBe("USAGE_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
// list-policies
// ---------------------------------------------------------------------------

describe("iamRun — list-policies", () => {
  it("returns curated policies with name, arn, id, attachedTo, updated", async () => {
    const stub = createStub({ stdout: LIST_POLICIES_RESPONSE, exitCode: 0 });
    const result = await iamRun({
      op: "list-policies",
      args: [],
      binary: stub,
    });

    expect(result).toHaveProperty("policies");
    const policies = result["policies"] as Array<Record<string, unknown>>;
    expect(policies).toHaveLength(2);

    const first = policies[0]!;
    expect(first["name"]).toBe("AdministratorAccess");
    expect(first["arn"]).toBe("arn:aws:iam::aws:policy/AdministratorAccess");
    expect(first["id"]).toBe("ANPATEST1");
    expect(first["attachedTo"]).toBe(5);
    expect(first["updated"]).toBe("2023-01-01T00:00:00+00:00");

    // Raw noise not included
    expect(first).not.toHaveProperty("Path");
    expect(first).not.toHaveProperty("DefaultVersionId");
    expect(first).not.toHaveProperty("IsAttachable");
  });

  it("includes a count field", async () => {
    const stub = createStub({ stdout: LIST_POLICIES_RESPONSE, exitCode: 0 });
    const result = await iamRun({ op: "list-policies", args: [], binary: stub });
    expect(result["count"]).toBe(2);
  });

  it("reports truncation with next-token when NextToken is present", async () => {
    const stub = createStub({ stdout: LIST_POLICIES_TRUNCATED, exitCode: 0 });
    const result = await iamRun({ op: "list-policies", args: [], binary: stub });

    expect(result["truncated"]).toBe(true);
    expect(result["nextToken"]).toBe("eyJhbGciOiJIUzI1NiJ9.policy-next-token");
    const help = result["help"] as string[];
    expect(help.some((h) => h.includes("--next-token"))).toBe(true);
  });

  it("returns definitive empty state when no policies exist", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ Policies: [] }),
      exitCode: 0,
    });
    const result = await iamRun({ op: "list-policies", args: [], binary: stub });
    expect(result["policies"]).toEqual([]);
    expect(result["count"]).toBe(0);
    expect(result["help"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// get-policy
// ---------------------------------------------------------------------------

describe("iamRun — get-policy", () => {
  it("returns curated policy projection", async () => {
    const stub = createStub({ stdout: GET_POLICY_RESPONSE, exitCode: 0 });
    const result = await iamRun({
      op: "get-policy",
      args: ["arn:aws:iam::aws:policy/AdministratorAccess"],
      binary: stub,
    });

    expect(result).toHaveProperty("policy");
    const policy = result["policy"] as Record<string, unknown>;
    expect(policy["name"]).toBe("AdministratorAccess");
    expect(policy["arn"]).toBe("arn:aws:iam::aws:policy/AdministratorAccess");
    expect(policy["id"]).toBe("ANPATEST1");
    expect(policy["attachedTo"]).toBe(5);
    expect(policy["updated"]).toBe("2023-01-01T00:00:00+00:00");

    // Raw noise not included
    expect(policy).not.toHaveProperty("Path");
    expect(policy).not.toHaveProperty("DefaultVersionId");
  });

  it("throws USAGE_ERROR when policy ARN is missing", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });
    try {
      await iamRun({ op: "get-policy", args: [], binary: stub });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect((e as AxiError).code).toBe("USAGE_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
// list-attached-role-policies
// ---------------------------------------------------------------------------

describe("iamRun — list-attached-role-policies", () => {
  it("returns curated attached policies list", async () => {
    const stub = createStub({
      stdout: LIST_ATTACHED_POLICIES_RESPONSE,
      exitCode: 0,
    });
    const result = await iamRun({
      op: "list-attached-role-policies",
      args: ["my-role"],
      binary: stub,
    });

    expect(result).toHaveProperty("attachedPolicies");
    const policies = result[
      "attachedPolicies"
    ] as Array<Record<string, unknown>>;
    expect(policies).toHaveLength(2);

    const first = policies[0]!;
    expect(first["name"]).toBe("AdministratorAccess");
    expect(first["arn"]).toBe(
      "arn:aws:iam::aws:policy/AdministratorAccess",
    );

    expect(result["roleName"]).toBe("my-role");
    expect(result["count"]).toBe(2);
  });

  it("reports truncation with next-token and resume command", async () => {
    const stub = createStub({
      stdout: LIST_ATTACHED_POLICIES_TRUNCATED,
      exitCode: 0,
    });
    const result = await iamRun({
      op: "list-attached-role-policies",
      args: ["my-role"],
      binary: stub,
    });

    expect(result["truncated"]).toBe(true);
    expect(result["nextToken"]).toBe("eyJhbGciOiJIUzI1NiJ9.attached-next-token");
    const help = result["help"] as string[];
    // Must include both a description and the resume command
    expect(help.length).toBeGreaterThanOrEqual(2);
    expect(help.some((h) => h.includes("aws-axi iam list-attached-role-policies"))).toBe(true);
    expect(help.some((h) => h.includes("--next-token"))).toBe(true);
  });

  it("returns empty state when no policies attached", async () => {
    const stub = createStub({
      stdout: JSON.stringify({ AttachedPolicies: [] }),
      exitCode: 0,
    });
    const result = await iamRun({
      op: "list-attached-role-policies",
      args: ["my-role"],
      binary: stub,
    });

    expect(result["attachedPolicies"]).toEqual([]);
    expect(result["count"]).toBe(0);
    expect(result["help"]).toBeDefined();
  });

  it("throws USAGE_ERROR when role name is missing", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });
    try {
      await iamRun({
        op: "list-attached-role-policies",
        args: [],
        binary: stub,
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect((e as AxiError).code).toBe("USAGE_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
// iamRun credential / service error propagation
// ---------------------------------------------------------------------------

describe("iamRun — error propagation", () => {
  it("propagates auth error from aws (NO_CREDENTIALS or NO_PROFILE_SELECTED)", async () => {
    // The exact code depends on whether ~/.aws/config has named profiles:
    //   NO_CREDENTIALS       — no profiles configured at all
    //   NO_PROFILE_SELECTED  — profiles exist but none was selected
    // Both are auth-family errors; the command layer must surface whichever applies.
    const AUTH_CODES = new Set(["NO_CREDENTIALS", "NO_PROFILE_SELECTED"]);
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    try {
      await iamRun({ op: "list-roles", args: [], binary: stub });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect(AUTH_CODES.has((e as AxiError).code)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 1: Flag form acceptance (ADR-0002 superset contract)
//
// Real `aws iam get-role`, `get-policy`, and `list-attached-role-policies`
// each require a named flag (--role-name, --policy-arn). aws-axi historically
// only accepted a bare positional. Under ADR-0002, BOTH forms must work.
//
// Assertion strategy: capture child argv via a stub that writes $@ to a file
// AND emits the required JSON on stdout. Assert on the captured argv (per
// issue spec: "assert on captured child argv, not intermediate return values").
// ---------------------------------------------------------------------------

/**
 * Build a stub script that writes its argv to capturePath and emits stdout.
 * Uses the pooled stubBin allocator (safe here — no binary-path-keyed caches).
 */
function makeArgCapturingStub(capturePath: string, stdout: string): string {
  return stubBin(
    [
      "#!/bin/sh",
      // Write all argv to the capture file so the test can inspect them.
      `echo "$@" > ${shellQuote(capturePath)}`,
      `printf '%s' ${shellQuote(stdout)}`,
      "exit 0",
    ].join("\n"),
  );
}

describe("iamRun — list-attached-role-policies — flag form (Part 1 fix)", () => {
  it("accepts --role-name flag form and forwards --role-name to child aws", async () => {
    const capturePath = join(tmpdir(), `iam-larp-flag-${process.pid}.txt`);
    const stub = makeArgCapturingStub(capturePath, LIST_ATTACHED_POLICIES_RESPONSE);

    const result = await iamRun({
      op: "list-attached-role-policies",
      args: ["--role-name", "twin-markets-prod-role"],
      binary: stub,
    });

    const captured = readFileSync(capturePath, "utf-8").trim();
    // Child aws must receive --role-name (not the role name as a bare positional)
    expect(captured).toContain("--role-name");
    expect(captured).toContain("twin-markets-prod-role");
    // Overlay projection must still work
    expect(result["roleName"]).toBe("twin-markets-prod-role");
    expect(result["count"]).toBe(2);
    try { rmSync(capturePath); } catch { /* best-effort */ }
  });

  it("flag form and positional form produce identical child argv", async () => {
    const capturePosPath = join(tmpdir(), `iam-larp-pos-${process.pid}.txt`);
    const captureFlagPath = join(tmpdir(), `iam-larp-flagform-${process.pid}.txt`);

    const posStub = makeArgCapturingStub(capturePosPath, LIST_ATTACHED_POLICIES_RESPONSE);
    const flagStub = makeArgCapturingStub(captureFlagPath, LIST_ATTACHED_POLICIES_RESPONSE);

    await iamRun({ op: "list-attached-role-policies", args: ["my-role"], binary: posStub });
    await iamRun({ op: "list-attached-role-policies", args: ["--role-name", "my-role"], binary: flagStub });

    const posCapture = readFileSync(capturePosPath, "utf-8").trim();
    const flagCapture = readFileSync(captureFlagPath, "utf-8").trim();
    // Both forms must produce the same child invocation
    expect(posCapture).toBe(flagCapture);
    try { rmSync(capturePosPath); rmSync(captureFlagPath); } catch { /* best-effort */ }
  });

  it("accepts --role-name=value equals form", async () => {
    const capturePath = join(tmpdir(), `iam-larp-eq-${process.pid}.txt`);
    const stub = makeArgCapturingStub(capturePath, LIST_ATTACHED_POLICIES_RESPONSE);

    const result = await iamRun({
      op: "list-attached-role-policies",
      args: ["--role-name=twin-markets-prod-role"],
      binary: stub,
    });

    expect(result["roleName"]).toBe("twin-markets-prod-role");
    const captured = readFileSync(capturePath, "utf-8").trim();
    expect(captured).toContain("--role-name");
    expect(captured).toContain("twin-markets-prod-role");
    try { rmSync(capturePath); } catch { /* best-effort */ }
  });

  it("throws USAGE_ERROR naming both values when positional and --role-name conflict", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });
    try {
      await iamRun({
        op: "list-attached-role-policies",
        args: ["my-role", "--role-name", "other-role"],
        binary: stub,
      });
      expect(true).toBe(false); // unreachable
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect((e as AxiError).code).toBe("USAGE_ERROR");
      // Message must name both conflicting values so the caller knows what to fix
      expect((e as AxiError).message).toContain("my-role");
      expect((e as AxiError).message).toContain("other-role");
    }
  });
});

describe("iamRun — get-role — flag form (Part 1 fix)", () => {
  it("accepts --role-name flag form and forwards --role-name to child aws", async () => {
    const capturePath = join(tmpdir(), `iam-gr-flag-${process.pid}.txt`);
    const stub = makeArgCapturingStub(capturePath, GET_ROLE_RESPONSE);

    const result = await iamRun({
      op: "get-role",
      args: ["--role-name", "my-role"],
      binary: stub,
    });

    const captured = readFileSync(capturePath, "utf-8").trim();
    expect(captured).toContain("--role-name");
    expect(captured).toContain("my-role");
    // Overlay projection still works
    const role = result["role"] as Record<string, unknown>;
    expect(role["name"]).toBe("my-role");
    try { rmSync(capturePath); } catch { /* best-effort */ }
  });

  it("flag form and positional form produce identical child argv for get-role", async () => {
    const capturePosPath = join(tmpdir(), `iam-gr-pos-${process.pid}.txt`);
    const captureFlagPath = join(tmpdir(), `iam-gr-flagform-${process.pid}.txt`);

    const posStub = makeArgCapturingStub(capturePosPath, GET_ROLE_RESPONSE);
    const flagStub = makeArgCapturingStub(captureFlagPath, GET_ROLE_RESPONSE);

    await iamRun({ op: "get-role", args: ["my-role"], binary: posStub });
    await iamRun({ op: "get-role", args: ["--role-name", "my-role"], binary: flagStub });

    expect(readFileSync(capturePosPath, "utf-8").trim()).toBe(
      readFileSync(captureFlagPath, "utf-8").trim(),
    );
    try { rmSync(capturePosPath); rmSync(captureFlagPath); } catch { /* best-effort */ }
  });

  it("throws USAGE_ERROR naming both values when positional and --role-name conflict for get-role", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });
    try {
      await iamRun({
        op: "get-role",
        args: ["my-role", "--role-name", "other-role"],
        binary: stub,
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect((e as AxiError).code).toBe("USAGE_ERROR");
      expect((e as AxiError).message).toContain("my-role");
      expect((e as AxiError).message).toContain("other-role");
    }
  });
});

describe("iamRun — get-policy — flag form (Part 1 fix)", () => {
  it("accepts --policy-arn flag form and forwards --policy-arn to child aws", async () => {
    const capturePath = join(tmpdir(), `iam-gp-flag-${process.pid}.txt`);
    const TEST_ARN = "arn:aws:iam::aws:policy/AdministratorAccess";
    const stub = makeArgCapturingStub(capturePath, GET_POLICY_RESPONSE);

    const result = await iamRun({
      op: "get-policy",
      args: ["--policy-arn", TEST_ARN],
      binary: stub,
    });

    const captured = readFileSync(capturePath, "utf-8").trim();
    expect(captured).toContain("--policy-arn");
    expect(captured).toContain(TEST_ARN);
    const policy = result["policy"] as Record<string, unknown>;
    expect(policy["name"]).toBe("AdministratorAccess");
    try { rmSync(capturePath); } catch { /* best-effort */ }
  });

  it("flag form and positional form produce identical child argv for get-policy", async () => {
    const TEST_ARN = "arn:aws:iam::aws:policy/AdministratorAccess";
    const capturePosPath = join(tmpdir(), `iam-gp-pos-${process.pid}.txt`);
    const captureFlagPath = join(tmpdir(), `iam-gp-flagform-${process.pid}.txt`);

    const posStub = makeArgCapturingStub(capturePosPath, GET_POLICY_RESPONSE);
    const flagStub = makeArgCapturingStub(captureFlagPath, GET_POLICY_RESPONSE);

    await iamRun({ op: "get-policy", args: [TEST_ARN], binary: posStub });
    await iamRun({ op: "get-policy", args: ["--policy-arn", TEST_ARN], binary: flagStub });

    expect(readFileSync(capturePosPath, "utf-8").trim()).toBe(
      readFileSync(captureFlagPath, "utf-8").trim(),
    );
    try { rmSync(capturePosPath); rmSync(captureFlagPath); } catch { /* best-effort */ }
  });

  it("throws USAGE_ERROR naming both values when positional and --policy-arn conflict", async () => {
    const stub = createStub({ stdout: "", exitCode: 0 });
    try {
      await iamRun({
        op: "get-policy",
        args: [
          "arn:aws:iam::aws:policy/ReadOnlyAccess",
          "--policy-arn",
          "arn:aws:iam::aws:policy/AdministratorAccess",
        ],
        binary: stub,
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      expect((e as AxiError).code).toBe("USAGE_ERROR");
      expect((e as AxiError).message).toContain("ReadOnlyAccess");
      expect((e as AxiError).message).toContain("AdministratorAccess");
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2: get-policy error classification (NO_CREDENTIALS false-positive)
//
// Reported against a valid --profile admin SSO session: get-policy returned
// NO_CREDENTIALS while other operations (logs describe-log-groups) succeeded.
//
// Investigation: after PR #79 (structural enrichment), awsJson routes through
// awsRaw which is the single enrichment site. The enrichment path for get-policy
// is now: iamRun → awsJson → awsRaw → parseAwsError → enrichNoCredsError.
//
// These tests prove that get-policy (overlay path) classifies errors correctly:
//   - A botocore AccessDenied error → SERVICE_CLIENT_ERROR (not NO_CREDENTIALS)
//   - A real "Unable to locate credentials" error → NO_CREDENTIALS (correct)
//
// Result: Part 2 does NOT reproduce on current main (23bfffe). The #79
// structural fix (single-site enrichment via awsRaw) eliminated the divergent
// code paths that could have caused misclassification. Only Part 1 ships.
// ---------------------------------------------------------------------------

describe("iamRun — get-policy — error classification (Part 2 evidence)", () => {
  it("classifies AccessDenied botocore error as SERVICE_CLIENT_ERROR (not NO_CREDENTIALS)", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (AccessDenied) when calling the GetPolicy operation: User is not authorized",
      exitCode: 254,
    });
    try {
      await iamRun({
        op: "get-policy",
        args: ["arn:aws:iam::aws:policy/AdministratorAccess"],
        binary: stub,
      });
      expect(true).toBe(false); // unreachable
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      // Must be SERVICE_CLIENT_ERROR — not NO_CREDENTIALS (the false-positive #53 reported)
      expect((e as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    }
  });

  it("classifies genuine 'Unable to locate credentials' as NO_CREDENTIALS (correct)", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    try {
      await iamRun({
        op: "get-policy",
        args: ["arn:aws:iam::aws:policy/AdministratorAccess"],
        binary: stub,
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(AxiError);
      // Genuine no-creds error must be classified as NO_CREDENTIALS (or upgraded to
      // NO_PROFILE_SELECTED if named profiles exist — both are correct).
      const AUTH_CODES = new Set(["NO_CREDENTIALS", "NO_PROFILE_SELECTED"]);
      expect(AUTH_CODES.has((e as AxiError).code)).toBe(true);
    }
  });
});
