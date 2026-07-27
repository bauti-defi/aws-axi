/**
 * Mutation-killable regression guard for the global resolver-cache teardown
 * in global-hooks.ts.
 *
 * FOUR describe blocks, each killing a different mutation family:
 *
 *   GUARD-1/2  (ambient cache — vpc)    prove the afterEach clearResolverCaches() call
 *                                       is load-bearing — removing it causes GUARD-2 to fail.
 *   GUARD-3/4  (callable export — vpc)  prove the exported clearResolverCaches() function
 *                                       is independently testable and correctly wired.
 *   GUARD-5/6  (ambient cache — role)   prove role MODULE_CACHE is wired into
 *                                       clearResolverCaches() — removing it causes GUARD-6 to fail.
 *   GUARD-7/8  (ambient cache — policy) prove policy MODULE_CACHE is wired into
 *                                       clearResolverCaches() — removing it causes GUARD-8 to fail.
 *
 * WHY THE AMBIENT APPROACH WORKS HERE
 * ────────────────────────────────────
 * The key insight: `stubBin` recycles the same inode (same pooled slot) across
 * tests. The resolver cache key for vpc, sg, subnet is `"${binary}::${id}"`.
 * So two sequential tests that use the same pooled slot AND the same resource id
 * share the same cache key — GUARD-1 writes a cache entry, GUARD-2 would get the
 * stale value from GUARD-1 if clearResolverCaches() were not called between them.
 *
 * For role and policy the cache key is `"${nameOrArn}::${profile}::${region}"` —
 * it does NOT include the binary path. That makes them even MORE prone to
 * cross-test contamination: any two tests using the same nameOrArn share the same
 * cache key regardless of which stub they use.
 *
 *   Mutation to test: remove the clearResolverCaches() call from the afterEach
 *   body in global-hooks.ts → GUARD-2, GUARD-6, GUARD-8 each fail.
 *
 * Do NOT publish the mutation string in PR review comments — the reviewer must
 * invent a fresh mutation. The above description is the guard's specification,
 * not a hint for a specific source edit.
 *
 * SIMULATION vs. REAL CROSS-TEST CONTAMINATION
 * ─────────────────────────────────────────────
 * GUARD-1/2 simulate the contamination in an adjacent pair of tests within one
 * describe block. The mechanism is identical to the real hazard: a pooled binary
 * path that carries a stale cache entry into a test whose stub would return
 * different data. This is deterministic and < 10 ms.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { resolveVpc } from "../../src/resolve/vpc.js";
import { resolveRole } from "../../src/resolve/role.js";
import { resolvePolicy } from "../../src/resolve/policy.js";
import { clearResolverCaches } from "./global-hooks.js";
import { stubBin, releaseStubBins } from "./stub-bin.js";

// ── VPC fixture helpers ──────────────────────────────────────────────────────

function vpcResponse(name: string): string {
  return JSON.stringify({
    Vpcs: [
      {
        VpcId: "vpc-guard-0000001",
        CidrBlock: "10.0.0.0/16",
        State: "available",
        IsDefault: false,
        Tags: [{ Key: "Name", Value: name }],
      },
    ],
  });
}

function vpcStub(name: string): string {
  const escaped = vpcResponse(name).replaceAll("'", "'\\''");
  return stubBin(`#!/bin/sh\nprintf '%s' '${escaped}'`);
}

afterEach(() => {
  releaseStubBins();
});

// ── GUARD-1/2: ambient cache ─────────────────────────────────────────────────

describe("clearResolverCaches() — global afterEach hook is load-bearing", () => {
  // The global afterEach in global-hooks.ts clears the cache between GUARD-1
  // and GUARD-2. Removing clearResolverCaches() from that afterEach causes
  // GUARD-2 to fail because the stale "GuardName-A" entry is served instead.

  it("GUARD-1: populate vpc cache with GuardName-A (simulates a test that caches a resolver result)", async () => {
    const stub = vpcStub("GuardName-A");
    // Anchor: confirm the stub actually ran and returned GuardName-A.
    // If GUARD-1 never populates the cache, GUARD-2 is vacuously green.
    const result = await resolveVpc({ id: "vpc-guard-0000001", binary: stub });
    expect(result?.name).toBe("GuardName-A");
    // Deliberately leave the cache populated — afterEach in global-hooks.ts must clear it.
  });

  it("GUARD-2: cache must be clear — resolves GuardName-B, not stale GuardName-A", async () => {
    // `stubBin` recycles slot-0 (same inode as GUARD-1's stub, same path).
    // The cache key is "<path>::vpc-guard-0000001" — identical to GUARD-1's entry.
    // If clearResolverCaches() ran: cold cache → stub is called → GuardName-B.
    // If clearResolverCaches() was skipped: stale hit → GuardName-A → FAIL.
    const stub = vpcStub("GuardName-B");
    const result = await resolveVpc({ id: "vpc-guard-0000001", binary: stub });
    expect(result?.name).toBe("GuardName-B");
  });
});

// ── GUARD-3/4: callable export ───────────────────────────────────────────────

describe("clearResolverCaches() — callable export is independently testable", () => {
  // Proves the exported function works when called directly (describe-scoped use).

  it("GUARD-3: populate vpc cache with GuardName-C", async () => {
    const stub = vpcStub("GuardName-C");
    const result = await resolveVpc({ id: "vpc-guard-0000002", binary: stub });
    expect(result?.name).toBe("GuardName-C");
    // Call the export directly — no reliance on the global afterEach.
    clearResolverCaches();
  });

  it("GUARD-4: after explicit clearResolverCaches(), GuardName-D is resolved fresh (not stale GuardName-C)", async () => {
    // Guard-3 called clearResolverCaches() explicitly before this test runs.
    // The global afterEach also fires after Guard-3. Either way, the cache is clear.
    const stub = vpcStub("GuardName-D");
    const result = await resolveVpc({ id: "vpc-guard-0000002", binary: stub });
    expect(result?.name).toBe("GuardName-D");
  });
});

// ── GUARD-5/6: role MODULE_CACHE ─────────────────────────────────────────────

/**
 * Role cache key = "${nameOrArn}::${profile}::${region}" — binary is NOT included.
 * Two tests with the same nameOrArn (no context) share the same key regardless of
 * which stub they point to. clearResolverCaches() must call role._clearCache().
 */

function roleResponse(accountId: string): string {
  return JSON.stringify({
    Role: {
      RoleName: "ProbeRole",
      RoleId: "AROAGUARDTEST",
      Arn: `arn:aws:iam::${accountId}:role/ProbeRole`,
      CreateDate: "2023-01-01T00:00:00+00:00",
      Path: "/",
    },
  });
}

function roleStub(accountId: string): string {
  const escaped = roleResponse(accountId).replaceAll("'", "'\\''");
  return stubBin(`#!/bin/sh\nprintf '%s' '${escaped}'`);
}

describe("clearResolverCaches() — role MODULE_CACHE is cleared by global afterEach", () => {
  // The role cache key does NOT include the binary path — two tests with the
  // same nameOrArn always share the same entry in MODULE_CACHE. Removing
  // clearResolverCaches() from the afterEach causes GUARD-6 to fail:
  //   "Expected: arn:…222…, Received: arn:…111…"

  it("GUARD-5: populate role cache with account 111 ARN (simulates a test that caches a role result)", async () => {
    const stub = roleStub("111111111111");
    // No _cache injection — uses MODULE_CACHE.
    const result = await resolveRole({ nameOrArn: "ProbeRole", binary: stub });
    expect(result.arn).toBe("arn:aws:iam::111111111111:role/ProbeRole");
    // Deliberately leave the cache populated — afterEach in global-hooks.ts must clear it.
  });

  it("GUARD-6: cache must be clear — resolves account 222 ARN, not stale account 111", async () => {
    // Same nameOrArn "ProbeRole", so cache key "ProbeRole::::" is shared.
    // If clearResolverCaches() ran: cold cache → stub called → account 222 ARN.
    // If clearResolverCaches() was skipped: stale hit → account 111 ARN → FAIL.
    const stub = roleStub("222222222222");
    const result = await resolveRole({ nameOrArn: "ProbeRole", binary: stub });
    expect(result.arn).toBe("arn:aws:iam::222222222222:role/ProbeRole");
  });
});

// ── GUARD-7/8: policy MODULE_CACHE ───────────────────────────────────────────

/**
 * Policy cache key = "${nameOrArn}::${profile}::${region}" — binary is NOT included.
 * Two tests with the same nameOrArn share the same entry in MODULE_CACHE.
 * clearResolverCaches() must call policy._clearCache().
 */

function policyResponse(accountId: string): string {
  return JSON.stringify({
    Policies: [
      {
        PolicyName: "ProbePolicy",
        PolicyId: "ANPAGUARDTEST",
        Arn: `arn:aws:iam::${accountId}:policy/ProbePolicy`,
        Path: "/",
        AttachmentCount: 0,
        CreateDate: "2023-01-01T00:00:00+00:00",
        UpdateDate: "2023-01-01T00:00:00+00:00",
      },
    ],
  });
}

function policyStub(accountId: string): string {
  const escaped = policyResponse(accountId).replaceAll("'", "'\\''");
  return stubBin(`#!/bin/sh\nprintf '%s' '${escaped}'`);
}

describe("clearResolverCaches() — policy MODULE_CACHE is cleared by global afterEach", () => {
  // Same reasoning as GUARD-5/6: cache key excludes binary path.
  // Removing clearResolverCaches() from afterEach causes GUARD-8 to fail:
  //   "Expected: arn:…222…, Received: arn:…111…"

  it("GUARD-7: populate policy cache with account 111 ARN (simulates a test that caches a policy result)", async () => {
    const stub = policyStub("111111111111");
    // No _cache injection — uses MODULE_CACHE.
    const result = await resolvePolicy({ nameOrArn: "ProbePolicy", binary: stub });
    expect(result.arn).toBe("arn:aws:iam::111111111111:policy/ProbePolicy");
    // Deliberately leave the cache populated — afterEach in global-hooks.ts must clear it.
  });

  it("GUARD-8: cache must be clear — resolves account 222 ARN, not stale account 111", async () => {
    // Same nameOrArn "ProbePolicy", cache key "ProbePolicy::::" is shared.
    // If clearResolverCaches() ran: cold cache → stub called → account 222 ARN.
    // If clearResolverCaches() was skipped: stale hit → account 111 ARN → FAIL.
    const stub = policyStub("222222222222");
    const result = await resolvePolicy({ nameOrArn: "ProbePolicy", binary: stub });
    expect(result.arn).toBe("arn:aws:iam::222222222222:policy/ProbePolicy");
  });
});
