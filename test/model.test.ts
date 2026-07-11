/**
 * Tests for src/model.ts — botocore model reader.
 *
 * Two tiers:
 *   1. Fixture-based (deterministic): pinned synthetic service under test/fixtures/.
 *   2. Live-path: validates real botocore discovery and a stable real service (STS).
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findBotocoreDataDir,
  loadService,
  getOperation,
  getPaginator,
  getWaiter,
  listWaiters,
} from "../src/model.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

// ── Fixture-based tests ───────────────────────────────────────────────────────

describe("loadService — fixture", () => {
  it("loads the fake-svc fixture and returns a ServiceModel", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    expect(model.service).toBe("fake-svc");
    expect(model.apiVersion).toBe("2020-01-01");
    expect(model.operations.size).toBe(3);
  });

  it("is idempotent — second call returns same cached object", () => {
    const a = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const b = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    expect(a).toBe(b);
  });
});

// ── getOperation ──────────────────────────────────────────────────────────────

describe("getOperation — fixture", () => {
  it("returns empty required and errors for SimpleOp", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const op = getOperation(model, "SimpleOp");
    expect(op.name).toBe("SimpleOp");
    expect(op.required).toEqual([]);
    expect(op.errors).toEqual([]);
  });

  it("returns required params for RequiredOp", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const op = getOperation(model, "RequiredOp");
    expect(op.required).toContain("Bucket");
    expect(op.required).toContain("Key");
    expect(op.required).not.toContain("Count");
  });

  it("returns error codes for RequiredOp (uses error.code from shape, falls back to shape name)", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const op = getOperation(model, "RequiredOp");
    // NotFoundException.error.code = 'NotFound'; AccessDeniedException.error.code = 'AccessDenied'
    expect(op.errors).toContain("NotFound");
    expect(op.errors).toContain("AccessDenied");
    expect(op.errors).not.toContain("NotFoundException");
    expect(op.errors).not.toContain("AccessDeniedException");
  });

  it("throws for an unknown operation name", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    expect(() => getOperation(model, "NonExistentOp")).toThrow();
  });
});

// ── distilled signature ───────────────────────────────────────────────────────

describe("getOperation — distilled signature", () => {
  it("produces input params with name, type, and required flag", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const op = getOperation(model, "RequiredOp");
    const { inputParams } = op.signature;

    const bucket = inputParams.find((p) => p.name === "Bucket");
    const count = inputParams.find((p) => p.name === "Count");

    expect(bucket).toBeDefined();
    expect(bucket?.type).toBe("string");
    expect(bucket?.required).toBe(true);

    expect(count).toBeDefined();
    expect(count?.type).toBe("integer");
    expect(count?.required).toBe(false);
  });

  it("lists top-level output field names", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const op = getOperation(model, "RequiredOp");
    expect(op.signature.outputFields).toContain("Result");
  });

  it("returns empty inputParams for an op with no input members", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const op = getOperation(model, "SimpleOp");
    expect(op.signature.inputParams).toEqual([]);
  });
});

// ── getPaginator ──────────────────────────────────────────────────────────────

describe("getPaginator — fixture", () => {
  it("returns pagination config for PaginatedOp", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const pg = getPaginator(model, "PaginatedOp");
    expect(pg).toBeDefined();
    expect(pg?.resultKeys).toContain("Items");
    expect(pg?.inputToken).toBe("NextToken");
    expect(pg?.outputToken).toBe("NextToken");
    expect(pg?.limitKey).toBe("MaxResults");
  });

  it("returns undefined for an op with no paginator", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    expect(getPaginator(model, "SimpleOp")).toBeUndefined();
  });

  it("returns undefined for an unknown op name", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    expect(getPaginator(model, "NoSuchOp")).toBeUndefined();
  });
});

// ── waiters ───────────────────────────────────────────────────────────────────

describe("listWaiters — fixture", () => {
  it("lists waiter names (raw PascalCase keys from botocore)", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    expect(listWaiters(model)).toContain("ItemReady");
  });
});

describe("getWaiter — fixture", () => {
  it("returns the ItemReady waiter definition by PascalCase key", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const waiter = getWaiter(model, "ItemReady");
    expect(waiter).toBeDefined();
    expect(waiter?.name).toBe("ItemReady");
    expect(waiter?.operation).toBe("PaginatedOp");
    expect(waiter?.delay).toBe(5);
    expect(waiter?.maxAttempts).toBe(20);
    expect(waiter?.acceptors).toHaveLength(2);
  });

  it("returns undefined for an unknown waiter", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    expect(getWaiter(model, "NoSuchWaiter")).toBeUndefined();
  });

  it("parses acceptor fields correctly", () => {
    const model = loadService("fake-svc", { dataDir: FIXTURES_DIR });
    const waiter = getWaiter(model, "ItemReady");
    const success = waiter?.acceptors.find((a) => a.state === "success");
    expect(success?.matcher).toBe("pathAll");
    expect(success?.expected).toBe("available");
    expect(success?.argument).toBe("Items[].Status");
  });
});

// ── findBotocoreDataDir ───────────────────────────────────────────────────────

describe("findBotocoreDataDir", () => {
  it("accepts an explicit override path", () => {
    const result = findBotocoreDataDir({ override: FIXTURES_DIR });
    expect(result).toBe(FIXTURES_DIR);
  });

  it("throws with an actionable message for a non-existent override", () => {
    expect(() =>
      findBotocoreDataDir({ override: "/does/not/exist" }),
    ).toThrow(/does not exist/);
  });

  it("discovers the real botocore data dir via which aws on this machine", () => {
    // Live path — requires aws CLI installed. Skip if not found.
    let found: string | undefined;
    try {
      found = findBotocoreDataDir();
    } catch {
      // aws CLI not installed in this environment — skip
      return;
    }
    expect(found).toBeTruthy();
    // Must contain at least one service directory
    const { readdirSync } = require("node:fs");
    const entries = readdirSync(found) as string[];
    expect(entries.length).toBeGreaterThan(0);
  });
});

// ── live botocore — STS ───────────────────────────────────────────────────────

describe("loadService — live botocore (STS)", () => {
  it("loads real STS model and AssumeRole has required params", () => {
    let stsModel;
    try {
      stsModel = loadService("sts");
    } catch {
      // aws CLI not installed — skip
      return;
    }
    const ar = getOperation(stsModel, "AssumeRole");
    expect(ar.required).toContain("RoleArn");
    expect(ar.required).toContain("RoleSessionName");
  });

  it("GetCallerIdentity has empty required and no errors", () => {
    let stsModel;
    try {
      stsModel = loadService("sts");
    } catch {
      return;
    }
    const gci = getOperation(stsModel, "GetCallerIdentity");
    expect(gci.required).toEqual([]);
    expect(gci.errors).toEqual([]);
  });

  it("STS has no paginators for GetCallerIdentity", () => {
    let stsModel;
    try {
      stsModel = loadService("sts");
    } catch {
      return;
    }
    expect(getPaginator(stsModel, "GetCallerIdentity")).toBeUndefined();
  });

  it("STS has no waiters", () => {
    let stsModel;
    try {
      stsModel = loadService("sts");
    } catch {
      return;
    }
    expect(listWaiters(stsModel)).toEqual([]);
  });
});

// ── live botocore — EC2 ───────────────────────────────────────────────────────

describe("loadService — live botocore (EC2)", () => {
  it("DescribeInstances paginator has result_key Reservations", () => {
    let ec2Model;
    try {
      ec2Model = loadService("ec2");
    } catch {
      return;
    }
    const pg = getPaginator(ec2Model, "DescribeInstances");
    expect(pg).toBeDefined();
    expect(pg?.resultKeys).toContain("Reservations");
  });

  it("EC2 has an InstanceRunning waiter targeting DescribeInstances", () => {
    let ec2Model;
    try {
      ec2Model = loadService("ec2");
    } catch {
      return;
    }
    const waiter = getWaiter(ec2Model, "InstanceRunning");
    expect(waiter).toBeDefined();
    expect(waiter?.operation).toBe("DescribeInstances");
    expect(waiter?.delay).toBe(15);
    expect(waiter?.maxAttempts).toBe(40);
    expect(listWaiters(ec2Model)).toContain("InstanceRunning");
  });
});
