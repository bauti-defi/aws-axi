/**
 * Tests for the EC2 command:
 *   - EC2 networking reads: describe-vpcs / describe-subnets / describe-security-groups
 *   - EC2 instances reads: describe-instances (with SG/subnet/role enrichment)
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
  it("throws AxiError on AWS credential error (NO_CREDENTIALS or NO_PROFILE_SELECTED)", async () => {
    // The exact code depends on whether ~/.aws/config has named profiles.
    // Both codes are auth-family; the command layer must surface whichever applies.
    const AUTH_CODES = new Set(["NO_CREDENTIALS", "NO_PROFILE_SELECTED"]);
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
      expect(AUTH_CODES.has((e as AxiError).code)).toBe(true);
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

// ===========================================================================
// EC2 instances — describe-instances (Tier-1, slice #11)
// ===========================================================================

/**
 * Multi-operation dispatch stub.
 *
 * The aws binary receives args as:
 *   $1 = service  (ec2 | iam)
 *   $2 = operation (describe-instances | describe-security-groups | describe-subnets)
 *
 * We key on $2 and return the pre-configured JSON for each operation.
 * Unrecognised operations exit 1 so tests fail loudly on unexpected calls.
 */
function shellQuoteMulti(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function createDispatchStub(responses: {
  readonly [operation: string]: { readonly stdout: string; readonly exitCode?: number };
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-ec2-inst-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");

  const cases = Object.entries(responses)
    .map(([op, { stdout, exitCode }]) => {
      return [
        `  ${op})`,
        `    printf '%s' ${shellQuoteMulti(stdout)}`,
        `    exit ${exitCode ?? 0}`,
        `    ;;`,
      ].join("\n");
    })
    .join("\n");

  const script = [
    "#!/bin/sh",
    `case "$2" in`,
    cases,
    "  *)",
    `    printf '%s' "unexpected operation: $2" >&2`,
    "    exit 1",
    "    ;;",
    "esac",
  ].join("\n");

  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

// ---------------------------------------------------------------------------
// Pinned fixture JSON — instances
// ---------------------------------------------------------------------------

/** A single running instance with SGs, subnet, and instance profile. */
const INSTANCE_FULL = JSON.stringify({
  Reservations: [
    {
      ReservationId: "r-0a1b2c3d4e5f67890",
      OwnerId: "123456789012",
      Groups: [],
      Instances: [
        {
          InstanceId: "i-0a1b2c3d4e5f67890",
          InstanceType: "t3.micro",
          State: { Code: 16, Name: "running" },
          Placement: { AvailabilityZone: "us-east-1a", Tenancy: "default" },
          PrivateIpAddress: "10.0.1.5",
          PublicIpAddress: "34.201.1.1",
          SubnetId: "subnet-0a1b2c3d4e5f67890",
          VpcId: "vpc-0a1b2c3d4e5f67890",
          SecurityGroups: [
            { GroupId: "sg-0a1b2c3d4e5f67890", GroupName: "prod-web-sg" },
          ],
          IamInstanceProfile: {
            Arn: "arn:aws:iam::123456789012:instance-profile/prod-ec2-role",
            Id: "AIPA0123456789ABCDEF",
          },
          Tags: [{ Key: "Name", Value: "prod-web-1" }],
          LaunchTime: "2026-07-01T12:00:00+00:00",
          Architecture: "x86_64",
        },
      ],
    },
  ],
});

/** Two reservations (two instances) with a synthesized NextToken. */
const INSTANCES_PAGE_ONE = JSON.stringify({
  Reservations: [
    {
      ReservationId: "r-aaaaaaaaaa0000001",
      OwnerId: "123456789012",
      Groups: [],
      Instances: [
        {
          InstanceId: "i-0aaaaaaaaaa000001",
          InstanceType: "t3.small",
          State: { Code: 16, Name: "running" },
          Placement: { AvailabilityZone: "us-east-1b" },
          PrivateIpAddress: "10.0.2.10",
          SubnetId: "subnet-0a1b2c3d4e5f67890",
          VpcId: "vpc-0a1b2c3d4e5f67890",
          SecurityGroups: [
            { GroupId: "sg-0a1b2c3d4e5f67890", GroupName: "prod-web-sg" },
          ],
          Tags: [{ Key: "Name", Value: "worker-1" }],
          LaunchTime: "2026-07-01T08:00:00+00:00",
          Architecture: "x86_64",
        },
      ],
    },
    {
      ReservationId: "r-aaaaaaaaaa0000002",
      OwnerId: "123456789012",
      Groups: [],
      Instances: [
        {
          InstanceId: "i-0aaaaaaaaaa000002",
          InstanceType: "t3.small",
          State: { Code: 16, Name: "running" },
          Placement: { AvailabilityZone: "us-east-1c" },
          PrivateIpAddress: "10.0.3.10",
          SubnetId: "subnet-0a1b2c3d4e5f67890",
          VpcId: "vpc-0a1b2c3d4e5f67890",
          SecurityGroups: [],
          Tags: [],
          LaunchTime: "2026-07-01T09:00:00+00:00",
          Architecture: "arm64",
        },
      ],
    },
  ],
  // Synthesized NextToken emitted by botocore --max-items paginator
  NextToken:
    "eyJOZXh0VG9rZW4iOiBudWxsLCAiYm90b190cnVuY2F0ZV9hbW91bnQiOiAyfQ==",
});

/** Instance without a public IP or instance profile. */
const INSTANCE_MINIMAL = JSON.stringify({
  Reservations: [
    {
      ReservationId: "r-minimalminimal001",
      OwnerId: "123456789012",
      Groups: [],
      Instances: [
        {
          InstanceId: "i-minimalminimal001",
          InstanceType: "t2.nano",
          State: { Code: 80, Name: "stopped" },
          Placement: { AvailabilityZone: "eu-west-1a" },
          PrivateIpAddress: "172.31.0.5",
          SubnetId: "subnet-0a1b2c3d4e5f67890",
          VpcId: "vpc-0a1b2c3d4e5f67890",
          SecurityGroups: [],
          Tags: [],
          LaunchTime: "2026-06-01T00:00:00+00:00",
          Architecture: "x86_64",
        },
      ],
    },
  ],
});

const INSTANCES_EMPTY = JSON.stringify({ Reservations: [] });

/** SG stub response for enrichment. */
const SG_ENRICH = JSON.stringify({
  SecurityGroups: [
    {
      GroupId: "sg-0a1b2c3d4e5f67890",
      GroupName: "prod-web-sg",
      Description: "Production web security group",
      VpcId: "vpc-0a1b2c3d4e5f67890",
      IpPermissions: [],
      IpPermissionsEgress: [],
    },
  ],
});

/** Subnet stub response for enrichment. */
const SUBNET_ENRICH = JSON.stringify({
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

// ---------------------------------------------------------------------------
// describe-instances — enriched happy path
// ---------------------------------------------------------------------------

describe("ec2Run describe-instances — enriched happy path", () => {
  it("returns curated instance list with resolved SG name, subnet name, and role name", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCE_FULL },
      "describe-security-groups": { stdout: SG_ENRICH },
      "describe-subnets": { stdout: SUBNET_ENRICH },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    expect(result).toHaveProperty("instances");
    const instances = result.instances as Array<{
      id: string;
      name: string;
      state: string;
      type: string;
      az: string;
      privateIp: string;
      publicIp: string | null;
      subnet: string | null;
      securityGroups: string[];
      role: string | null;
    }>;

    expect(instances).toHaveLength(1);

    const inst = instances[0];
    expect(inst).toBeDefined();
    expect(inst?.id).toBe("i-0a1b2c3d4e5f67890");
    expect(inst?.name).toBe("prod-web-1");
    expect(inst?.state).toBe("running");
    expect(inst?.type).toBe("t3.micro");
    expect(inst?.az).toBe("us-east-1a");
    expect(inst?.privateIp).toBe("10.0.1.5");
    expect(inst?.publicIp).toBe("34.201.1.1");

    // Enriched: human names, not raw IDs
    expect(inst?.subnet).toBe("prod-subnet-a");
    expect(inst?.securityGroups).toEqual(["prod-web-sg"]);
    // Role name extracted from instance-profile ARN (pure parse, no network)
    expect(inst?.role).toBe("prod-ec2-role");

    expect(result).toHaveProperty("count", 1);
    expect(result).not.toHaveProperty("nextToken");
  });

  it("falls back to instance-id as name when no Name tag", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCE_MINIMAL },
      "describe-subnets": { stdout: SUBNET_ENRICH },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    const instances = result.instances as Array<{ id: string; name: string }>;
    expect(instances[0]?.name).toBe("i-minimalminimal001");
  });

  it("sets publicIp null when instance has no public address", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCE_MINIMAL },
      "describe-subnets": { stdout: SUBNET_ENRICH },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    const instances = result.instances as Array<{ publicIp: string | null }>;
    expect(instances[0]?.publicIp).toBeNull();
  });

  it("sets role null when instance has no IamInstanceProfile", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCE_MINIMAL },
      "describe-subnets": { stdout: SUBNET_ENRICH },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    const instances = result.instances as Array<{ role: string | null }>;
    expect(instances[0]?.role).toBeNull();
  });

  it("returns empty securityGroups array when instance has none", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCE_MINIMAL },
      "describe-subnets": { stdout: SUBNET_ENRICH },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    const instances = result.instances as Array<{ securityGroups: string[] }>;
    expect(instances[0]?.securityGroups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// describe-instances — pagination cap on synthesized NextToken
// ---------------------------------------------------------------------------

describe("ec2Run describe-instances — pagination cap", () => {
  it("reports truncation and nextToken ONLY when synthesized NextToken is present", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCES_PAGE_ONE },
      "describe-security-groups": { stdout: SG_ENRICH },
      "describe-subnets": { stdout: SUBNET_ENRICH },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    // Flattened: 1 instance per reservation × 2 reservations = 2 instances
    expect(result).toHaveProperty("count", 2);
    expect(result).toHaveProperty("truncated", true);
    expect(result).toHaveProperty("nextToken");
    expect(typeof (result as { nextToken: unknown }).nextToken).toBe("string");

    // Resume hint must include --next-token
    const help = result.help as string[];
    expect(help.some((h) => h.includes("--next-token"))).toBe(true);
  });

  it("does NOT report truncation when NextToken is absent (complete page)", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCE_FULL },
      "describe-security-groups": { stdout: SG_ENRICH },
      "describe-subnets": { stdout: SUBNET_ENRICH },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    expect(result).not.toHaveProperty("truncated");
    expect(result).not.toHaveProperty("nextToken");
  });
});

// ---------------------------------------------------------------------------
// describe-instances — empty state
// ---------------------------------------------------------------------------

describe("ec2Run describe-instances — empty state", () => {
  it("returns empty instances list with count 0 and help suggestion", async () => {
    const stub = createDispatchStub({
      "describe-instances": { stdout: INSTANCES_EMPTY },
    });

    const result = await ec2Run({
      operation: "describe-instances",
      binary: stub,
    });

    expect(result).toHaveProperty("instances");
    expect((result.instances as unknown[]).length).toBe(0);
    expect(result).toHaveProperty("count", 0);

    // Must include a help suggestion on empty
    expect(result).toHaveProperty("help");
    const help = result.help as string[];
    expect(help.length).toBeGreaterThan(0);
    // Suggestion should reference how to run instances
    expect(help.some((h) => h.toLowerCase().includes("run-instances") || h.toLowerCase().includes("instance"))).toBe(true);
  });
});
