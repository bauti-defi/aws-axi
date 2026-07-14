/**
 * Wire harness: PATH-shim `aws` + real CLI entrypoint.
 *
 * Proves that `s3 cp` and `s3 rm` with two-arg boolean flags (`--dryrun false`,
 * `--recursive false`) correctly route S3 URIs as positionals — not silently
 * replaced by the boolean literal.
 *
 * Architecture:
 *   - A PATH-shim `aws` script writes every argv token (one per line) to a temp
 *     file, then exits 0.  Assertions are on the LITERAL ARGV that reached the
 *     child process (index-based for positional slots, contains-based for flags).
 *   - `s3Command(args, undefined, binary)` drives the real CLI entrypoint through
 *     the full overlay dispatch path.
 *
 * Harness liveness guard (per round-3 review):
 *   Each test group anchors with a "stub IS invoked" assertion: the argv log file
 *   must exist and contain at least one token.  A dead binary (wrong path / crash)
 *   leaves the log absent → liveness assertion fails, harness is clearly dead.
 *
 * Pre-fix RED proof (`2d7b784`):
 *   Committed `2d7b784` is the head before this fix.  The same tests run there
 *   and go RED on every two-arg flag + positional combination:
 *
 *   | test | 2d7b784 result |
 *   |---|---|
 *   | rm --dryrun false <uri> (flag before positional) | argv[rm+1]="false" 🔴 |
 *   | rm <uri> --dryrun false (flag after positional) | argv[rm+1]="s3://…" ✅ (was OK) |
 *   | cp --dryrun false <src> <dst> | argv[cp+1]="false" 🔴 |
 *   | cp --exclude value <src> <dst> | argv[cp+1]="*.log" 🔴 |
 *   | rm --recursive false <uri> | argv[rm+1]="false" 🔴 |
 *
 *   After the fix (extractPositionals in overlay-args.ts + s3.ts), all go GREEN.
 *
 * Scope:
 *   - s3 rm — flag-before-positional, flag-after-positional, equals form, bare
 *   - s3 cp — both orderings, equals form, bare, multi-arg passthrough (--exclude)
 *   - s3 rm --recursive false
 *   - No secrets/ssm coverage (already in wire-reveal.test.ts)
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  writeFileSync,
  chmodSync,
  rmSync,
  mkdtempSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { s3Command } from "../src/commands/s3.js";

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/**
 * Create a PATH-shim `aws` binary that logs every argv token (one per line)
 * to `logFile`, then exits 0.
 *
 * Liveness guarantee: the script ALWAYS writes the "s3" token on invocation.
 * If the log file is absent or empty after the call, the binary was never
 * invoked (harness dead → liveness assertion below will fail).
 */
function createArgvLoggingStub(logFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-wire-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");
  // Each argv token on its own line — mirrors how `$@` expands per-element.
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > ${logFile}\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Read logged argv tokens from the file written by the stub. */
function readArgv(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
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
// s3 rm — two-arg --dryrun / --recursive shifts target URI
// ---------------------------------------------------------------------------

describe("wire: s3 rm — two-arg boolean flags do not shift S3 URI (positional extraction)", () => {
  /**
   * Liveness anchor: no boolean flags — stub must be invoked and log written.
   * If this test fails, the harness is dead and all following results are void.
   */
  it("anchor: stub IS invoked for s3 rm (log file non-empty)", async () => {
    const logFile = join(tmpdir(), `s3-rm-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(["rm", "s3://bucket/anchor-key"], undefined, binary);

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);   // harness is alive
    expect(argv).toContain("s3");              // aws s3 rm was invoked
    expect(argv).toContain("s3://bucket/anchor-key");
  });

  /**
   * PRIMARY BUG: flag-before-positional ordering.
   *
   * `s3 rm --dryrun false s3://bucket/important-key`
   *
   * Pre-fix (2d7b784):
   *   naive filter → positionals = ["false", "s3://bucket/important-key"]
   *   target = "false"  → argv[rm+1] = "false"  🔴
   *
   * Post-fix:
   *   extractPositionals(S3_BOOL_FLAGS) → positionals = ["s3://bucket/important-key"]
   *   target = "s3://bucket/important-key"  → argv[rm+1] = "s3://…"  ✅
   */
  it("rm --dryrun false <uri> (flag before positional): correct URI is at argv[rm+1]", async () => {
    const logFile = join(tmpdir(), `s3-rm-df-before-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--dryrun", "false", "s3://bucket/important-key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);   // liveness

    // The rm verb is always at a known position after "s3".
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    // The token immediately after "rm" must be the S3 URI — not the literal "false".
    expect(argv[rmIdx + 1]).toBe("s3://bucket/important-key");
    // "false" must not be the target (it may or may not appear elsewhere, but
    // --dryrun false → dryRun=false → --dryrun is NOT forwarded at all, so
    // "false" must also be absent from the full argv).
    expect(argv).not.toContain("false");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * Flag-after-positional ordering: was correct pre-fix (URI is first in rest).
   * Regression guard — must stay correct after the shared extractPositionals lands.
   */
  it("rm <uri> --dryrun false (flag after positional): URI still correct", async () => {
    const logFile = join(tmpdir(), `s3-rm-df-after-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "s3://bucket/important-key", "--dryrun", "false"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const rmIdx = argv.indexOf("rm");
    expect(argv[rmIdx + 1]).toBe("s3://bucket/important-key");
    expect(argv).not.toContain("false");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * Equals form — regression guard from round-2 (#55).
   */
  it("rm <uri> --dryrun=false (equals form): URI correct, --dryrun absent", async () => {
    const logFile = join(tmpdir(), `s3-rm-df-eq-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "s3://bucket/important-key", "--dryrun=false"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const rmIdx = argv.indexOf("rm");
    expect(argv[rmIdx + 1]).toBe("s3://bucket/important-key");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * Bare --dryrun (no value) — regression guard, must still forward --dryrun.
   */
  it("rm <uri> --dryrun (bare): --dryrun IS forwarded to aws", async () => {
    const logFile = join(tmpdir(), `s3-rm-dryrun-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "s3://bucket/important-key", "--dryrun"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const rmIdx = argv.indexOf("rm");
    expect(argv[rmIdx + 1]).toBe("s3://bucket/important-key");
    expect(argv).toContain("--dryrun");
  });

  /** Other falsy literals: 0, no. */
  it("rm --dryrun 0 <uri>: correct URI, --dryrun absent", async () => {
    const logFile = join(tmpdir(), `s3-rm-df-0-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--dryrun", "0", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    const rmIdx = argv.indexOf("rm");
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
    // --dryrun 0 → dryRun=false → --dryrun not forwarded
    expect(argv).not.toContain("--dryrun");
  });

  it("rm --dryrun no <uri>: correct URI, --dryrun absent", async () => {
    const logFile = join(tmpdir(), `s3-rm-df-no-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--dryrun", "no", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    const rmIdx = argv.indexOf("rm");
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * --recursive false: the target URI must be at argv[rm+1], not "false".
   *
   * Note: --recursive is forwarded to aws s3 rm as a passthrough flag
   * (collectPassthroughFlags treats it as an unknown value-flag and will
   * forward it with its "false" value).  The key invariant is the target URI
   * position — it must not be displaced by the "false" literal.
   *
   * Pre-fix (2d7b784): naive filter → target = "false" → argv[rm+1] = "false" 🔴
   * Post-fix:          extractPositionals → target = "s3://bucket/prefix/"    ✅
   */
  it("rm --recursive false <uri> (flag before positional): correct URI is at argv[rm+1]", async () => {
    const logFile = join(tmpdir(), `s3-rm-recursive-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--recursive", "false", "s3://bucket/prefix/"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);   // liveness
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    // The token immediately after "rm" must be the S3 URI, not "false".
    expect(argv[rmIdx + 1]).toBe("s3://bucket/prefix/");
  });
});

// ---------------------------------------------------------------------------
// s3 cp — two-arg boolean flag shifts source/destination
// ---------------------------------------------------------------------------

describe("wire: s3 cp — two-arg boolean flags do not shift source/destination", () => {
  /**
   * Liveness anchor.
   */
  it("anchor: stub IS invoked for s3 cp (log file non-empty)", async () => {
    const logFile = join(tmpdir(), `s3-cp-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain("s3");
    expect(argv).toContain("s3://bucket/src.txt");
    expect(argv).toContain("./out.txt");
  });

  /**
   * PRIMARY BUG — download shape, flag before positionals.
   *
   * `s3 cp --dryrun false s3://bucket/important.txt ./out.txt`
   *
   * Pre-fix (2d7b784):
   *   naive filter → positionals = ["false", "s3://bucket/important.txt", "./out.txt"]
   *   source = "false", destination = "s3://bucket/important.txt"
   *   This is a DOWNLOAD→UPLOAD inversion: aws attempts to upload local file
   *   "false" over s3://bucket/important.txt.
   *   argv[cp+1] = "false"  🔴
   *
   * Post-fix:
   *   extractPositionals → positionals = ["s3://bucket/important.txt", "./out.txt"]
   *   source = "s3://bucket/important.txt", destination = "./out.txt"  ✅
   *   argv[cp+1] = "s3://bucket/important.txt"  ✅
   */
  it("cp --dryrun false <src> <dst> (flag before positionals): correct source is at argv[cp+1]", async () => {
    const logFile = join(tmpdir(), `s3-cp-df-before-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--dryrun", "false", "s3://bucket/important.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);   // liveness
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    // Source must be the S3 URI, not "false".
    expect(argv[cpIdx + 1]).toBe("s3://bucket/important.txt");
    // Destination must follow source.
    expect(argv[cpIdx + 2]).toBe("./out.txt");
    // "false" must not appear (--dryrun false → dryRun=false → no --dryrun forwarded)
    expect(argv).not.toContain("false");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * Upload shape — flag before positionals.
   */
  it("cp --dryrun false ./local.txt s3://bucket/key (upload, flag first): correct argv[cp+1..+2]", async () => {
    const logFile = join(tmpdir(), `s3-cp-upload-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--dryrun", "false", "./local.txt", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    expect(argv).not.toContain("false");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * Flag-after-positionals — was correct pre-fix. Regression guard.
   */
  it("cp <src> <dst> --dryrun false (flag after positionals): source/dest still correct", async () => {
    const logFile = join(tmpdir(), `s3-cp-df-after-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "s3://bucket/important.txt", "./out.txt", "--dryrun", "false"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(argv[cpIdx + 1]).toBe("s3://bucket/important.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
    expect(argv).not.toContain("false");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * Equals form — regression guard.
   */
  it("cp <src> <dst> --dryrun=false (equals form): source/dest correct, --dryrun absent", async () => {
    const logFile = join(tmpdir(), `s3-cp-df-eq-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "s3://bucket/important.txt", "./out.txt", "--dryrun=false"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(argv[cpIdx + 1]).toBe("s3://bucket/important.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
    expect(argv).not.toContain("--dryrun");
  });

  /**
   * Bare --dryrun — regression guard, must still forward --dryrun.
   */
  it("cp <src> <dst> --dryrun (bare): --dryrun IS forwarded", async () => {
    const logFile = join(tmpdir(), `s3-cp-dryrun-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "s3://bucket/src.txt", "./out.txt", "--dryrun"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
    expect(argv).toContain("--dryrun");
  });

  /**
   * --exclude value-flag bug: naturally fixed by the shared extractPositionals.
   *
   * `s3 cp --exclude '*.log' ./a s3://b/k`
   *
   * Pre-fix (2d7b784):
   *   naive filter → positionals = ["*.log", "./a", "s3://b/k"]
   *   source = "*.log" (WRONG), destination = "./a" (WRONG)
   *   aws receives: s3 cp *.log ./a --exclude s3://b/k  ← all three corrupted
   *   argv[cp+1] = "*.log"  🔴
   *
   * Post-fix (extractPositionals):
   *   --exclude is a value flag (not in booleanFlags) → skip it + "*.log"
   *   positionals = ["./a", "s3://b/k"]
   *   source = "./a", destination = "s3://b/k"  ✅
   *   aws receives: s3 cp ./a s3://b/k --exclude *.log  ✅
   *   argv[cp+1] = "./a"  ✅
   *
   * This fix is a natural consequence of using the full flag-aware extractor
   * rather than a bool-literal special case — no separate special handling needed.
   */
  it("cp --exclude value <src> <dst>: source/dest not corrupted by value-flag argument", async () => {
    const logFile = join(tmpdir(), `s3-cp-exclude-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--exclude", "*.log", "./a", "s3://b/k"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);   // liveness
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    // Source must be "./a", NOT "*.log" (which was the pre-fix value).
    expect(argv[cpIdx + 1]).toBe("./a");
    // Destination must be "s3://b/k", NOT "./a".
    expect(argv[cpIdx + 2]).toBe("s3://b/k");
    // --exclude and its value must survive in passthrough.
    expect(argv).toContain("--exclude");
    expect(argv).toContain("*.log");
  });
});
