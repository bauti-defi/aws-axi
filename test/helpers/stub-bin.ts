/**
 * Shared allocator for stub `aws` executables used by the exec-seam tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every stub used to be a brand-new file under its own `mkdtemp` directory.
 * On macOS the FIRST exec of a never-before-seen inode pays a security
 * evaluation; re-executing an inode that has already been through it does not.
 * Measured on an M-series box (median of 25):
 *
 *   | how the executable is produced          | median exec |
 *   |-----------------------------------------|-------------|
 *   | new inode, unique content               |    413 ms   |
 *   | new inode, identical content            |    315 ms   |
 *   | SAME path, content rewritten each time  |    5.1 ms   |
 *   | same inode reached via new hardlinks    |    5.3 ms   |
 *   | same file re-executed unchanged         |    5.6 ms   |
 *
 * The penalty is keyed on the INODE, not on the path and not on the content —
 * rewriting one file in place costs ~5 ms no matter how different the new body
 * is. With ~90 stub factories across the suite that difference is minutes of
 * wall clock, and it is why tests intermittently blew through bun's default
 * 5000 ms per-test timeout under load (the failure that blocked the 0.5.0
 * release: `wire-s3-positional` at 5003 ms, `wire-reveal` at 5090 ms).
 *
 * So: allocate from a pool of stable paths and rewrite them in place.
 *
 * SAFETY
 * ------
 * Rewriting an executed path is only sound if the child runs the NEW bytes.
 * Verified explicitly — including shrinking rewrites and changed exit codes —
 * and guarded by `test/stub-bin.test.ts`, which fails if a stale image is ever
 * served.
 *
 * WHEN YOU MUST NOT POOL
 * ----------------------
 * Several resolvers memoize for the lifetime of the process under a key that
 * includes the binary path:
 *
 *   src/resolve/key.ts     (loadAliasMap — kms)
 *   src/resolve/sg.ts, subnet.ts, vpc.ts   (ec2)
 *
 * A pooled path handed to two different test cases would serve the FIRST
 * case's cached value to the second — a silent wrong-answer, far worse than a
 * slow test. Those tests must use `uniqueStubBin()`, which pays the ~400 ms to
 * mint a fresh inode and buys real cache isolation.
 *
 * Resolvers whose cache key omits the binary (`bucket.ts`, `role.ts`,
 * `policy.ts` — keyed on profile:region:name) are unaffected either way.
 */
import { writeFileSync, chmodSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Root for every stub this process creates; removed on exit. */
const POOL_ROOT = mkdtempSync(join(tmpdir(), "aws-axi-stubs-"));

/** Stable pooled paths, index-addressed. Slot N is always the same inode. */
const pool: string[] = [];

/** How many pooled slots are checked out by the current test. */
let cursor = 0;

/** Directories minted by `uniqueStubBin`, cleaned up on exit. */
const uniqueDirs: string[] = [];

function writeExecutable(path: string, script: string): string {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Allocate a stub `aws` executable containing `script`.
 *
 * Paths are stable across tests and recycled by `releaseStubBins()`, so the
 * inode is only ever evaluated once. Stubs checked out within a single test
 * always get distinct paths, so a test may hold several at once.
 *
 * Do NOT use for tests that depend on the binary path being unique across test
 * cases — see `uniqueStubBin`.
 */
export function stubBin(script: string): string {
  if (cursor === pool.length) {
    const dir = join(POOL_ROOT, `slot-${pool.length}`);
    mkdirSync(dir, { recursive: true });
    // Basename stays `aws` so anything that inspects argv[0] still sees `aws`.
    pool.push(join(dir, "aws"));
  }
  return writeExecutable(pool[cursor++]!, script);
}

/**
 * Return every pooled stub to the pool. Call from `afterEach`.
 *
 * Deliberately does NOT delete the files: keeping the inodes alive is the
 * entire point. They are removed when the process exits.
 */
export function releaseStubBins(): void {
  cursor = 0;
}

/**
 * Allocate a stub at a path that is never reused for the lifetime of the
 * process. Costs a fresh-inode exec (~300-650 ms on macOS) — only use it when
 * a binary-path-keyed cache in `src/resolve/` makes path identity load-bearing.
 */
export function uniqueStubBin(script: string): string {
  const dir = mkdtempSync(join(POOL_ROOT, "unique-"));
  uniqueDirs.push(dir);
  return writeExecutable(join(dir, "aws"), script);
}

process.on("exit", () => {
  try {
    rmSync(POOL_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort — temp dir, OS reclaims it */
  }
});
