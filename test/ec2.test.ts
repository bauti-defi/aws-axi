/**
 * Tests for the EC2 networking command (describe-vpcs / describe-subnets /
 * describe-security-groups) through a real stub aws binary.
 *
 * No mocks — the full `awsJson` exec seam runs with a subprocess boundary.
 * Stubs emit pinned EC2 JSON; we assert on curated output shapes.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ec2Run } from "../src/commands/ec2.js";
import { AxiError } from "axi-sdk-js";

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
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-ec2-"));
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

const VPC_TWO = JSON.stringify({
  Vpcs: [
    {
      VpcId: "vpc-0a1b2c3d4e5f67890",
      CidrBlock: "10.0.0.0/16",
      State: "available",
      IsDefault: false,
      OwnerId: "123456789012",
      Tags: [{ Key: "Name", Value: "prod-vpc" }],
    },
    {
      VpcId: "vpc-default111111111",
      CidrBlock: "172.31.0.0/16",
      State: "available",
      IsDefault: true,
      OwnerId: "123456789012",
      Tags: [],
    },
  ],
});

const VPC_EMPTY = JSON.stringify({ Vpcs: [] });

const SUBNET_PAGE_ONE = JSON.stringify({
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
    {
      SubnetId: "subnet-0b2c3d4e5f678901",
      VpcId: "vpc-0a1b2c3d4e5f67890",
      CidrBlock: "10.0.2.0/24",
      AvailabilityZone: "us-east-1b",
      AvailableIpAddressCount: 251,
      MapPublicIpOnLaunch: false,
      State: "available",
      Tags: [],
    },
  ],
  NextToken:
    "eyJOZXh0VG9rZW4iOiBudWxsLCAiYm90b190cnVuY2F0ZV9hbW91bnQiOiAyfQ==",
});

const SUBNET_COMPLETE = JSON.stringify({
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

const SG_WITH_RULES = JSON.stringify({
  SecurityGroups: [
    {
      GroupId: "sg-0a1b2c3d4e5f67890",
      GroupName: "prod-web-sg",
      Description: "Allow HTTPS and HTTP inbound",
      VpcId: "vpc-0a1b2c3d4e5f67890",
      OwnerId: "123456789012",
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          Ipv6Ranges: [],
          PrefixListIds: [],
          UserIdGroupPairs: [],
        },
        {
          IpProtocol: "tcp",
          FromPort: 80,
          ToPort: 80,
          IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          Ipv6Ranges: [],
          PrefixListIds: [],
          UserIdGroupPairs: [],
        },
      ],
      IpPermissionsEgress: [
        {
          IpProtocol: "-1",
          IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          Ipv6Ranges: [],
          PrefixListIds: [],
          UserIdGroupPairs: [],
        },
      ],
      Tags: [{ Key: "Name", Value: "web-sg" }],
    },
  ],
});

// ---------------------------------------------------------------------------
// describe-vpcs
// ---------------------------------------------------------------------------

describe("ec2Run describe-vpcs — happy path", () => {
  it("returns curated VPC list with name, cidr, state, default flag", async () => {
    const stub = createStub({ stdout: VPC_TWO, exitCode: 0 });
    const result = await ec2Run({
      operation: "describe-vpcs",
      binary: stub,
    });

    expect(result).toHaveProperty("vpcs");
    expect(Array.isArray(result.vpcs)).toBe(true);
    const vpcs = result.vpcs as Array<{
      id: string;
      name: string;
      cidr: string;
      state: string;
      default: boolean;
    }>;

    expect(vpcs).toHaveLength(2);

    const prod = vpcs.find((v) => v.id === "vpc-0a1b2c3d4e5f67890");
    expect(prod).toBeDefined();
    expect(prod?.name).toBe("prod-vpc");
    expect(prod?.cidr).toBe("10.0.0.0/16");
    expect(prod?.state).toBe("available");
    expect(prod?.default).toBe(false);

    const def = vpcs.find((v) => v.id === "vpc-default111111111");
    expect(def).toBeDefined();
    expect(def?.default).toBe(true);

    expect(result).toHaveProperty("count", 2);
    // No truncation — NextToken not present
    expect(result).not.toHaveProperty("nextToken");
  });
});

describe("ec2Run describe-vpcs — empty state", () => {
  it("returns empty list with count 0 and a help suggestion", async () => {
    const stub = createStub({ stdout: VPC_EMPTY, exitCode: 0 });
    const result = await ec2Run({
      operation: "describe-vpcs",
      binary: stub,
    });

    expect(result).toHaveProperty("vpcs");
    expect((result.vpcs as unknown[]).length).toBe(0);
    expect(result).toHaveProperty("count", 0);

    // Must include a help suggestion on empty
    expect(result).toHaveProperty("help");
    const help = result.help as string[];
    expect(help.length).toBeGreaterThan(0);
    expect(help[0]).toContain("create-vpc");
  });
});

// ---------------------------------------------------------------------------
// describe-subnets
// ---------------------------------------------------------------------------

describe("ec2Run describe-subnets — complete (no truncation)", () => {
  it("returns curated subnet list with az, cidr, vpc, availableIps", async () => {
    const stub = createStub({ stdout: SUBNET_COMPLETE, exitCode: 0 });
    const result = await ec2Run({
      operation: "describe-subnets",
      binary: stub,
    });

    expect(result).toHaveProperty("subnets");
    const subnets = result.subnets as Array<{
      id: string;
      name: string;
      vpc: string;
      cidr: string;
      az: string;
      availableIps: number;
      publicIpOnLaunch: boolean;
    }>;

    expect(subnets).toHaveLength(1);
    expect(subnets[0]?.id).toBe("subnet-0a1b2c3d4e5f67890");
    expect(subnets[0]?.name).toBe("prod-subnet-a");
    expect(subnets[0]?.vpc).toBe("vpc-0a1b2c3d4e5f67890");
    expect(subnets[0]?.cidr).toBe("10.0.1.0/24");
    expect(subnets[0]?.az).toBe("us-east-1a");
    expect(subnets[0]?.availableIps).toBe(250);
    expect(subnets[0]?.publicIpOnLaunch).toBe(false);

    expect(result).toHaveProperty("count", 1);
    expect(result).not.toHaveProperty("nextToken");
  });

  it("falls back to subnet id as name when no Name tag present", async () => {
    const stub = createStub({ stdout: SUBNET_PAGE_ONE, exitCode: 0 });
    const result = await ec2Run({
      operation: "describe-subnets",
      binary: stub,
    });

    const subnets = result.subnets as Array<{ id: string; name: string }>;
    const unnamed = subnets.find((s) => s.id === "subnet-0b2c3d4e5f678901");
    expect(unnamed).toBeDefined();
    // Falls back to the subnet id when no Name tag
    expect(unnamed?.name).toBe("subnet-0b2c3d4e5f678901");
  });
});

describe("ec2Run describe-subnets — paginated (NextToken present)", () => {
  it("reports truncation and includes nextToken in output", async () => {
    const stub = createStub({ stdout: SUBNET_PAGE_ONE, exitCode: 0 });
    const result = await ec2Run({
      operation: "describe-subnets",
      binary: stub,
    });

    // 2 items in page-one fixture
    expect(result).toHaveProperty("count", 2);
    expect(result).toHaveProperty("truncated", true);
    expect(result).toHaveProperty("nextToken");
    expect(typeof (result as { nextToken: unknown }).nextToken).toBe("string");

    // Must include pagination hint
    expect(result).toHaveProperty("help");
    const help = result.help as string[];
    expect(help.some((h) => h.includes("--next-token"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe-security-groups
// ---------------------------------------------------------------------------

describe("ec2Run describe-security-groups — happy path", () => {
  it("returns curated SG list with inbound/outbound rule counts", async () => {
    const stub = createStub({ stdout: SG_WITH_RULES, exitCode: 0 });
    const result = await ec2Run({
      operation: "describe-security-groups",
      binary: stub,
    });

    expect(result).toHaveProperty("securityGroups");
    const sgs = result.securityGroups as Array<{
      id: string;
      name: string;
      description: string;
      vpc: string;
      inboundRules: number;
      outboundRules: number;
    }>;

    expect(sgs).toHaveLength(1);
    expect(sgs[0]?.id).toBe("sg-0a1b2c3d4e5f67890");
    expect(sgs[0]?.name).toBe("prod-web-sg");
    expect(sgs[0]?.description).toBe("Allow HTTPS and HTTP inbound");
    expect(sgs[0]?.vpc).toBe("vpc-0a1b2c3d4e5f67890");
    expect(sgs[0]?.inboundRules).toBe(2);
    expect(sgs[0]?.outboundRules).toBe(1);

    expect(result).toHaveProperty("count", 1);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("ec2Run — error propagation", () => {
  it("throws AxiError on AWS credential error", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    await expect(
      ec2Run({ operation: "describe-vpcs", binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);

    try {
      const stub2 = createStub({
        stdout: "",
        stderr: "Unable to locate credentials",
        exitCode: 255,
      });
      await ec2Run({ operation: "describe-vpcs", binary: stub2 });
    } catch (e) {
      expect((e as AxiError).code).toBe("NO_CREDENTIALS");
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown operation guard
// ---------------------------------------------------------------------------

describe("ec2Run — unknown operation", () => {
  it("throws AxiError USAGE_ERROR for unsupported operations", async () => {
    // We pass an unknown operation string via type cast to test the runtime guard.
    await expect(
      ec2Run({
        operation: "run-instances" as "describe-vpcs",
        binary: "/dev/null",
      }),
    ).rejects.toBeInstanceOf(AxiError);

    try {
      await ec2Run({
        operation: "run-instances" as "describe-vpcs",
        binary: "/dev/null",
      });
    } catch (e) {
      expect((e as AxiError).code).toBe("USAGE_ERROR");
    }
  });
});
