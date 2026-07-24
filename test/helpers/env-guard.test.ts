/**
 * Mutation-killable regression guard for useEnvGuard() and restoreExitCode().
 *
 * GUARD-1/2 prove the afterEach body is load-bearing for env cleanup.
 * GUARD-3/4 test restoreExitCode() as a pure function — the only approach that
 * kills the `?? 0` mutant in a full-suite run.
 *
 * WHY PURE-FUNCTION TEST FOR exitCode
 * ────────────────────────────────────
 * The ambient-state approach (set process.exitCode = 252 in test N, assert 0
 * in test N+1) is order-dependent. In a full-suite run, earlier captureMain
 * files leave process.exitCode === 0. So beforeEach in GUARD-3 captures
 * exitCodeSnapshot = 0 rather than undefined. The mutant (`exitCodeSnapshot`
 * instead of `exitCodeSnapshot ?? 0`) then restores 0 correctly — the
 * mutation survives. Only in isolated file runs does beforeEach see undefined.
 *
 * A pure-function test has no ambient dependency: it passes undefined directly
 * and asserts the output regardless of what any prior test did to
 * process.exitCode. This is order-independent and cannot be neutralised by CI.
 *
 * SIMULATION vs. REAL TIMEOUT
 * ───────────────────────────
 * GUARD-1/2 use direct env injection rather than a real Bun test timeout.
 * Reason: a timed-out it() cannot be checked in green — Bun 1.3.14 reports
 * (fail) regardless of it.failing() wrappers. The simulated abandonment form
 * — "inject state without restoring it, verify the next test is clean" —
 * tests exactly what the hook guarantees (post-test cleanup) without relying
 * on the timeout mechanism. The result is deterministic and takes < 1 ms.
 *
 * The reviewer independently verified the real-timeout form on bun 1.3.14
 * (test/wire-reveal.test.ts with it(..., 100) + 5000 ms await): the finally
 * block did not run and the env var leaked — confirming this simulation
 * accurately represents the hazard. (That real-timeout demo is not checked in.)
 */
import { describe, it, expect } from "bun:test";
import { useEnvGuard, restoreExitCode } from "./env-guard.js";

const GUARD_KEY = "__AXI_ENV_GUARD_SENTINEL__";
const GUARD_VAL = "leaked-via-simulated-timeout-abandonment";

describe("useEnvGuard() — hooks are load-bearing", () => {
  // Register the guard under test. Removing the afterEach body in env-guard.ts
  // causes GUARD-2 to fail.
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
    // this assertion fails with "Expected: undefined, Received: GUARD_VAL".
    expect(process.env[GUARD_KEY]).toBeUndefined();
  });
});

describe("restoreExitCode() — ?? 0 branch is load-bearing", () => {
  // Pure-function tests: no ambient process.exitCode dependency, order-independent.
  // Mutation to test: change `snapshot ?? 0` to `snapshot` in env-guard.ts →
  // GUARD-3 fails in both isolated AND full-suite runs.

  it("GUARD-3: returns 0 when snapshot is undefined (the ?? 0 branch)", () => {
    // This is the critical case: process.exitCode = undefined is a no-op in Bun,
    // so the hook must use 0, not undefined, to clear a leaked non-zero code.
    // Mutant (`snapshot` alone) would return undefined; this assertion catches it.
    expect(restoreExitCode(undefined)).toBe(0);
  });

  it("GUARD-4: returns the snapshot when it is a concrete number", () => {
    // Non-zero snapshot must be preserved (e.g. a test that intentionally sets
    // process.exitCode = 1 should see it restored to 1, not clobbered to 0).
    expect(restoreExitCode(252)).toBe(252);
    expect(restoreExitCode(0)).toBe(0);
    expect(restoreExitCode(1)).toBe(1);
  });
});
