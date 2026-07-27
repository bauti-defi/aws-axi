/**
 * Global preload module — registered in bunfig.toml under [test] preload.
 *
 * Clears every module-level resolver cache after each test. This is the
 * authoritative cache teardown: because `bun test` runs all files in a single
 * process, module-level Maps persist across files, not just across tests within
 * a file. A per-file hook only protects files that remember to call it —
 * which reinstates exactly the classification burden this preload exists to
 * delete. The global afterEach applies to every test in every file automatically.
 *
 * WHY THESE CACHES NEED CLEARING
 * ──────────────────────────────
 * Five resolvers (vpc, sg, subnet, key, bucket) memoize AWS API results for the
 * lifetime of the process, keyed on binary-path + resource-id (or
 * profile:region:resource). When tests recycle pooled stub binaries (same inode,
 * different content), a stale cache entry from test N is silently served to
 * test N+1 as a correct hit — a silent wrong-answer that never produces a
 * failing assertion.
 *
 * Clearing caches after each test, combined with `stubBin` pooling (same inode
 * reused per test), eliminates the ~400 ms/inode macOS security-evaluation cost
 * that `uniqueStubBin` was paying. Measured improvement: −13.4 s / −30.7 %
 * wall time on the full suite (back-to-back, same session).
 *
 * CALLING FROM TESTS
 * ──────────────────
 * `clearResolverCaches()` is also exported so describe-scoped tests can call it
 * directly for a mid-block reset if ever needed. The global afterEach makes this
 * rare in practice.
 *
 * See test/helpers/global-hooks.test.ts for a mutation-killable guard.
 */
import { afterEach } from "bun:test";
import { _clearCache as clearVpc } from "../../src/resolve/vpc.js";
import { _clearCache as clearSg } from "../../src/resolve/sg.js";
import { _clearCache as clearSubnet } from "../../src/resolve/subnet.js";
import { _clearCache as clearKey } from "../../src/resolve/key.js";
import { _clearCache as clearLogGroup } from "../../src/resolve/log-group.js";
import { _clearCache as clearBucket } from "../../src/resolve/bucket.js";

/**
 * Clear every module-level resolver cache.
 *
 * Called by the global afterEach registered in this module. Also exported so
 * describe-scoped tests can invoke it directly when they need a mid-block reset.
 */
export function clearResolverCaches(): void {
  clearVpc();
  clearSg();
  clearSubnet();
  clearKey();
  clearLogGroup();
  clearBucket();
}

// Global afterEach — fires after every test in every file loaded in the process.
afterEach(() => {
  clearResolverCaches();
});
