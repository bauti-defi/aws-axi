/**
 * Mutation-killable regression guard for useEnvGuard() and restoreExitCode().
 *
 * THREE describe blocks; each kills a different mutation family:
 *
 *   GUARD-1/2  (ambient env)       prove the afterEach env-restore loops are load-bearing.
 *   GUARD-3/4  (pure function)     prove the `?? 0` branch in restoreExitCode() is load-bearing.
 *   GUARD-5/6  (ambient exitCode)  prove the call site in afterEach that calls restoreExitCode()
 *                                  is load-bearing (wiring guard).
 *
 * WHY THREE BLOCKS INSTEAD OF ONE
 * ────────────────────────────────
 * GUARD-3/4 test restoreExitCode() in isolation — they kill function-body mutants
 * (e.g. `snapshot ?? 1`, `snapshot as number`) but cannot detect a mutant that
 * keeps the function intact and bypasses the call site
 * (`process.exitCode = exitCodeSnapshot` instead of
 * `process.exitCode = restoreExitCode(exitCodeSnapshot)`). GUARD-5/6 fill that gap.
 *
 * GUARD-5/6 are ambient (they depend on process state). They kill mutation C
 * (delete call-site line) deterministically in any run; they kill mutation D
 * (bypass the fn at the call site) only when no parallel worker has yet set
 * process.exitCode = 0 — reliably in isolated file runs, ordering-dependent in
 * the full suite. The reviewer accepted this limitation ("certain orderings").
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

describe("useEnvGuard() — exitCode WIRING is load-bearing (GUARD-5/6 backstop)", () => {
  // Ambient backstop for two call-site mutations:
  //   C: delete `process.exitCode = restoreExitCode(exitCodeSnapshot)` entirely
  //   D: bypass to `process.exitCode = exitCodeSnapshot` (the original bug verbatim)
  //
  // GUARD-5/6 are complementary to GUARD-3/4 (pure-function):
  //   GUARD-3/4 kills function-body mutations — they test restoreExitCode() directly
  //   but cannot detect a mutant that keeps the function intact and skips the call.
  //   GUARD-5/6 fill that gap for call-site mutations.
  //
  // Mutation C (delete the entire line) is caught deterministically in any run:
  //   GUARD-5 leaks exitCode = 252; afterEach makes NO assignment; exitCode stays
  //   252; GUARD-6 asserts 0 → FAIL.
  //
  // Mutation D (bypass fn: process.exitCode = exitCodeSnapshot) is caught only
  // when exitCodeSnapshot is undefined — i.e. when this file's process starts fresh
  // (isolated file run: bun test test/helpers/env-guard.test.ts). In the full suite,
  // parallel workers may set exitCode = 0 before GUARD-5's beforeEach fires, making
  // exitCodeSnapshot = 0 and rendering mutation D indistinguishable from correct code.
  // This is the "certain orderings" limitation the reviewer accepted — mutation D
  // coverage here is a backstop, not a full-suite guarantee.
  useEnvGuard();

  it("GUARD-5: leak non-zero exitCode without any restore (anchors GUARD-6)", () => {
    // Simulate captureMain whose exitCode-reset line was abandoned on timeout.
    process.exitCode = 252;

    // Confirm injection (anchors GUARD-6: if GUARD-5 never ran, GUARD-6 is
    // vacuously green — exitCode would still be undefined, which is not 252).
    expect(process.exitCode).toBe(252);
  });

  it("GUARD-6: process.exitCode is 0 — afterEach called restoreExitCode(exitCodeSnapshot)", () => {
    // useEnvGuard's afterEach must have called:
    //   process.exitCode = restoreExitCode(exitCodeSnapshot)
    //
    // Mutation C (delete the entire line): afterEach makes no assignment; exitCode
    //   is still 252 from GUARD-5 → FAIL. Caught in every run (no ordering dep).
    // Mutation D (bypass fn → exitCodeSnapshot): if exitCodeSnapshot was undefined
    //   (fresh process in an isolated file run), undefined assignment is a no-op in
    //   Bun → exitCode stays 252 → FAIL. In the full suite, parallel workers may
    //   have set exitCode = 0 first, making mutation D undetectable (accepted limitation).
    expect(process.exitCode).toBe(0);
  });
});
