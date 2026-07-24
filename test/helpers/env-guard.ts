/**
 * Shared env-isolation hooks for captureMain test files.
 *
 * WHY THIS EXISTS
 * ───────────────
 * captureMain() saves/restores process.env in an inline try/finally. When Bun
 * abandons a timed-out test's promise that finally may not run before the next
 * test begins, leaking injected env vars (PATH, AWS_DATA_PATH, credential keys,
 * etc.) into subsequent tests. These hooks are the authoritative cleanup: the
 * framework guarantees they run even after a timeout.
 *
 * captureMain()'s own try/finally is retained as belt-and-suspenders — if the
 * test ends normally the env is cleaned twice (harmlessly); if Bun abandons the
 * promise the hook fires regardless.
 *
 * SNAPSHOT APPROACH
 * ─────────────────
 * We snapshot the FULL process.env (and process.exitCode) in beforeEach rather
 * than enumerating a static allowlist of keys. An allowlist only guards the
 * keys it names — any future key added to a captureMain call silently escapes.
 * The snapshot catches every key, current and future, with no maintenance cost.
 *
 * HOW TO USE
 * ──────────
 * Call useEnvGuard() at the top level of a test file (hooks all tests) or
 * inside a describe() block (hooks only that block). Both scopes work:
 *
 *   // top-level — covers every test in the file
 *   useEnvGuard();
 *
 *   // describe-scoped — covers only one block's tests
 *   describe("…", () => {
 *     useEnvGuard();
 *     …
 *   });
 *
 * If a block's beforeEach ALSO needs to delete specific keys from the env
 * (e.g. to eliminate ambient shell credentials), register an additional
 * beforeEach after the useEnvGuard() call. Bun runs them in declaration order,
 * so the snapshot is taken before the deletion, and afterEach restores both.
 *
 * GUARD TEST
 * ──────────
 * See test/helpers/env-guard.test.ts for a mutation-killable regression guard:
 * removing the afterEach body turns it RED, proving the hooks are load-bearing.
 */
import { beforeEach, afterEach } from "bun:test";

/**
 * Register beforeEach/afterEach hooks that snapshot and restore the full
 * process.env (and process.exitCode) around each test.
 *
 * This is the authoritative env + exit-code cleanup for any test file that
 * calls captureMain().
 */
export function useEnvGuard(): void {
  let envSnapshot: Record<string, string | undefined> = {};
  let exitCodeSnapshot: number | undefined;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    exitCodeSnapshot = process.exitCode as number | undefined;
  });

  afterEach(() => {
    // Remove any keys added during the test.
    for (const k of Object.keys(process.env)) {
      if (!(k in envSnapshot)) {
        delete process.env[k];
      }
    }
    // Restore any keys that were changed or removed.
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) {
        delete process.env[k];
      } else if (process.env[k] !== v) {
        process.env[k] = v;
      }
    }
    // Restore exit code (captureMain also resets this, but its finally may not
    // run on timeout — belt-and-suspenders here too).
    process.exitCode = exitCodeSnapshot;
  });
}
