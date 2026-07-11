/**
 * Tests for the resolve-vpc / resolve-subnet / resolve-sg primitives.
 *
 * No mocks — real stub aws binaries via the `binary` seam. Each primitive
 * resolves an AWS resource id to a human name using the Name tag (or
 * group-name for SGs), with in-process caching across repeated calls.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  writeFileSync,
  chmodSync,
  rmSync,
  mkdtempSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveVpc } from "../src/resolve/vpc.js";
import { resolveSubnet } from "../src/resolve/subnet.js";
import { resolveSg } from "../src/resolve/sg.js";

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
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

/**
 * Creates a stub that records call count in a counter file and returns
 * valid output only on the first invocation. Used to verify caching.
 */
function createCountingStub(stdout: string): {
  readonly binary: string;
  readonly counterFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-count-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  const counterFile = join(dir, "calls");

  const script = [
    "#!/bin/sh",
    // Read current count (default 0)
    `count=$(cat ${shellQuote(counterFile)} 2>/dev/null || echo 0)`,
    // Increment and persist
    `echo $((count + 1)) > ${shellQuote(counterFile)}`,
    // Only emit valid output on first call
    `if [ "$count" -eq 0 ]; then`,
    `  printf '%s' ${shellQuote(stdout)}`,
    `  exit 0`,
    `fi`,
    // Second call fails
    `printf '%s' 'stub called more than once' >&2`,
    `exit 1`,
  ].join("\n");

  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return { binary: p, counterFile };
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
// Pinned fixture JSON
// ---------------------------------------------------------------------------

const VPC_RESPONSE = JSON.stringify({
  Vpcs: [
    {
      VpcId: "vpc-0a1b2c3d4e5f67890",
      CidrBlock: "10.0.0.0/16",
      State: "available",
      IsDefault: false,
      Tags: [{ Key: "Name", Value: "prod-vpc" }],
    },
  ],
});

const VPC_NO_NAME = JSON.stringify({
  Vpcs: [
    {
      VpcId: "vpc-unnamedaabbcc1234",
      CidrBlock: "192.168.0.0/16",
      State: "available",
      IsDefault: false,
      Tags: [],
    },
  ],
});

const VPC_NOT_FOUND = JSON.stringify({ Vpcs: [] });

const SUBNET_RESPONSE = JSON.stringify({
  Subnets: [
    {
      SubnetId: "subnet-0a1b2c3d4e5f67890",
      VpcId: "vpc-0a1b2c3d4e5f67890",
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
      AvailableIpAddressCount: 250,
      MapPublicIpOnLaunch: false,
      State: "available",
      Tags: [{ Key: "Name", Value: "prod-subnet-a" }],
    },
  ],
});

const SUBNET_NOT_FOUND = JSON.stringify({ Subnets: [] });

const SG_RESPONSE = JSON.stringify({
  SecurityGroups: [
    {
      GroupId: "sg-0a1b2c3d4e5f67890",
      GroupName: "prod-web-sg",
      Description: "Allow HTTPS inbound",
      VpcId: "vpc-0a1b2c3d4e5f67890",
      IpPermissions: [],
      IpPermissionsEgress: [],
      Tags: [],
    },
  ],
});

const SG_NOT_FOUND = JSON.stringify({ SecurityGroups: [] });

// ---------------------------------------------------------------------------
// resolveVpc
// ---------------------------------------------------------------------------

describe("resolveVpc", () => {
  it("resolves vpc id to Name tag value", async () => {
    const stub = createStub({ stdout: VPC_RESPONSE, exitCode: 0 });
    const result = await resolveVpc({
      id: "vpc-0a1b2c3d4e5f67890",
      binary: stub,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("vpc-0a1b2c3d4e5f67890");
    expect(result?.name).toBe("prod-vpc");
    expect(result?.cidr).toBe("10.0.0.0/16");
  });

  it("falls back to vpc id as name when no Name tag", async () => {
    const stub = createStub({ stdout: VPC_NO_NAME, exitCode: 0 });
    const result = await resolveVpc({
      id: "vpc-unnamedaabbcc1234",
      binary: stub,
    });

    expect(result).not.toBeNull();
    expect(result?.name).toBe("vpc-unnamedaabbcc1234");
  });

  it("returns null when vpc id does not exist", async () => {
    const stub = createStub({ stdout: VPC_NOT_FOUND, exitCode: 0 });
    const result = await resolveVpc({
      id: "vpc-nonexistent1234567",
      binary: stub,
    });

    expect(result).toBeNull();
  });

  it("returns null on AWS error (does not throw)", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const result = await resolveVpc({
      id: "vpc-0a1b2c3d4e5f67890",
      binary: stub,
    });

    expect(result).toBeNull();
  });

  it("caches results — AWS is only called once for repeated id lookups", async () => {
    const { binary, counterFile } = createCountingStub(VPC_RESPONSE);

    const r1 = await resolveVpc({ id: "vpc-0a1b2c3d4e5f67890", binary });
    const r2 = await resolveVpc({ id: "vpc-0a1b2c3d4e5f67890", binary });

    // Both calls should resolve to the same value
    expect(r1?.name).toBe("prod-vpc");
    expect(r2?.name).toBe("prod-vpc");

    // Stub must have been invoked exactly once
    const callCount = existsSync(counterFile)
      ? parseInt(readFileSync(counterFile, "utf-8").trim(), 10)
      : 0;
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveSubnet
// ---------------------------------------------------------------------------

describe("resolveSubnet", () => {
  it("resolves subnet id to Name tag, az, and cidr", async () => {
    const stub = createStub({ stdout: SUBNET_RESPONSE, exitCode: 0 });
    const result = await resolveSubnet({
      id: "subnet-0a1b2c3d4e5f67890",
      binary: stub,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("subnet-0a1b2c3d4e5f67890");
    expect(result?.name).toBe("prod-subnet-a");
    expect(result?.az).toBe("us-east-1a");
    expect(result?.cidr).toBe("10.0.1.0/24");
    expect(result?.vpcId).toBe("vpc-0a1b2c3d4e5f67890");
  });

  it("returns null when subnet does not exist", async () => {
    const stub = createStub({ stdout: SUBNET_NOT_FOUND, exitCode: 0 });
    const result = await resolveSubnet({
      id: "subnet-nonexistent123",
      binary: stub,
    });

    expect(result).toBeNull();
  });

  it("returns null on AWS error (does not throw)", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const result = await resolveSubnet({
      id: "subnet-0a1b2c3d4e5f67890",
      binary: stub,
    });

    expect(result).toBeNull();
  });

  it("caches results — AWS is only called once for repeated id lookups", async () => {
    const { binary, counterFile } = createCountingStub(SUBNET_RESPONSE);

    const r1 = await resolveSubnet({
      id: "subnet-0a1b2c3d4e5f67890",
      binary,
    });
    const r2 = await resolveSubnet({
      id: "subnet-0a1b2c3d4e5f67890",
      binary,
    });

    expect(r1?.name).toBe("prod-subnet-a");
    expect(r2?.name).toBe("prod-subnet-a");

    const callCount = existsSync(counterFile)
      ? parseInt(readFileSync(counterFile, "utf-8").trim(), 10)
      : 0;
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveSg
// ---------------------------------------------------------------------------

describe("resolveSg", () => {
  it("resolves sg id to groupName and description", async () => {
    const stub = createStub({ stdout: SG_RESPONSE, exitCode: 0 });
    const result = await resolveSg({
      id: "sg-0a1b2c3d4e5f67890",
      binary: stub,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("sg-0a1b2c3d4e5f67890");
    expect(result?.name).toBe("prod-web-sg");
    expect(result?.description).toBe("Allow HTTPS inbound");
  });

  it("returns null when sg does not exist", async () => {
    const stub = createStub({ stdout: SG_NOT_FOUND, exitCode: 0 });
    const result = await resolveSg({
      id: "sg-nonexistent1234567",
      binary: stub,
    });

    expect(result).toBeNull();
  });

  it("returns null on AWS error (does not throw)", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const result = await resolveSg({
      id: "sg-0a1b2c3d4e5f67890",
      binary: stub,
    });

    expect(result).toBeNull();
  });

  it("caches results — AWS is only called once for repeated id lookups", async () => {
    const { binary, counterFile } = createCountingStub(SG_RESPONSE);

    const r1 = await resolveSg({ id: "sg-0a1b2c3d4e5f67890", binary });
    const r2 = await resolveSg({ id: "sg-0a1b2c3d4e5f67890", binary });

    expect(r1?.name).toBe("prod-web-sg");
    expect(r2?.name).toBe("prod-web-sg");

    const callCount = existsSync(counterFile)
      ? parseInt(readFileSync(counterFile, "utf-8").trim(), 10)
      : 0;
    expect(callCount).toBe(1);
  });
});
