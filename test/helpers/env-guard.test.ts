/**
 * Mutation-killable regression guard for useEnvGuard().
 *
 * Proves that the afterEach body is load-bearing: removing it turns GUARD-2
 * RED (the leaked env var survives into the next test). The guard catches
 * anyone who deletes the hook body or refactors it to a no-op.
 *
 * SIMULATION vs. REAL TIMEOUT
 * ───────────────────────────
 * This guard uses direct env injection rather than a real Bun test timeout.
 * Reason: a timed-out it() cannot be checked in green — Bun 1.3.14 reports
 * (fail) regardless of it.failing() wrappers. The simulated abandonment form
 * — "inject the env var, do NOT restore it, verify the next test is clean" —
 * tests exactly what the hook guarantees (post-test cleanup) without relying
 * on the timeout mechanism. The result is deterministic and takes < 1 ms.
 *
 * The reviewer independently verified the real-timeout form on bun 1.3.14
 * (test/wire-reveal.test.ts with it(..., 100) + 5000 ms await): the finally
 * block did not run and the env var leaked — confirming this simulation
 * accurately represents the hazard. (That real-timeout demo is not checked in.)
 */
import { describe, it, expect } from "bun:test";
import { useEnvGuard } from "./env-guard.js";

const GUARD_KEY = "__AXI_ENV_GUARD_SENTINEL__";
const GUARD_VAL = "leaked-via-simulated-timeout-abandonment";

describe("useEnvGuard() — hooks are load-bearing", () => {
  // Register the guard under test. Removing the afterEach body in env-guard.ts
  // causes GUARD-2 to fail: it sees the sentinel set in GUARD-1.
  useEnvGuard();

  it("GUARD-1: inject env var without any restore (simulates abandoned captureMain finally)", () => {
    // Set the sentinel directly — no try/finally, no restore.
    // This is the observable state Bun leaves when it abandons a promise
    // mid-await: the try block injected the value, the finally never ran.
    process.env[GUARD_KEY] = GUARD_VAL;

    // Confirm injection (anchors GUARD-2: if GUARD-1 never ran, GUARD-2 is vacuously green).
    expect(process.env[GUARD_KEY]).toBe(GUARD_VAL);
  });

  it("GUARD-2: env is clean — afterEach restored it before this test began", () => {
    // useEnvGuard()'s afterEach fired after GUARD-1. The sentinel must be gone.
    // Mutation to test: remove/comment the afterEach body in env-guard.ts →
    // this assertion fails with "Expected: not GUARD_VAL, Received: GUARD_VAL".
    expect(process.env[GUARD_KEY]).toBeUndefined();
  });
});
