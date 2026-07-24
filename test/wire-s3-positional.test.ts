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
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { s3Command } from "../src/commands/s3.js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

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
  // Each argv token on its own line — mirrors how `$@` expands per-element.
  const p = stubBin(`#!/bin/sh\nprintf '%s\\n' "$@" > ${logFile}\nexit 0\n`);
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
   * This test covers the POSITIONAL-EXTRACTION fix (2d7b784): extractPositionals
   * treats --recursive as a boolean (S3_BOOL_FLAGS) and does not eat "false" as
   * its positional, so the target URI lands correctly.
   *
   * A separate describe block below (#66) covers the PASSTHROUGH fix: after
   * extractPositionals, collectPassthroughFlags must also not forward the literal
   * "false" to the child aws.
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

// ---------------------------------------------------------------------------
// s3 cp / rm — global aws boolean flags must NOT eat S3 URI positionals
//
// Regression introduced in f66878c: extractPositionals treats ALL unknown
// --flags as value flags (skips next token).  GLOBAL_BOOL_FLAGS like
// --no-cli-pager, --debug, --no-paginate, --no-verify-ssl have no entry in
// S3_BOOL_FLAGS, so the token following them (a local path or S3 URI) is
// silently consumed as the flag's value.
//
// Pre-fix (f66878c):
//   s3 cp --no-cli-pager ./local.txt s3://bucket/key
//   → extractPositionals eats ./local.txt as value of --no-cli-pager
//   → positionals = ["s3://bucket/key"]  →  source OK, destination=undefined
//   → USAGE_ERROR (exit 252)
//
// Post-fix:
//   --no-cli-pager is in GLOBAL_BOOL_FLAGS → treated as boolean → no eat
//   → positionals = ["./local.txt", "s3://bucket/key"]  ✅
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — global aws bool flags do not eat S3 URI positionals", () => {
  /**
   * Liveness anchor.
   */
  it("anchor: stub IS invoked for s3 cp baseline (no global flags)", async () => {
    const logFile = join(tmpdir(), `s3-global-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(["cp", "./local.txt", "s3://bucket/key"], undefined, binary);

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain("./local.txt");
    expect(argv).toContain("s3://bucket/key");
  });

  /**
   * PRIMARY REGRESSION — f66878c: --no-cli-pager eats ./local.txt.
   *
   * `s3 cp --no-cli-pager ./local.txt s3://bucket/key`
   *
   * Pre-fix (f66878c):
   *   extractPositionals: --no-cli-pager not in S3_BOOL_FLAGS → value flag
   *   → skip ./local.txt  → positionals = ["s3://bucket/key"]
   *   → destination=undefined → USAGE_ERROR ← goes RED here
   *
   * Post-fix:
   *   --no-cli-pager in GLOBAL_BOOL_FLAGS → boolean → ./local.txt kept
   *   → positionals = ["./local.txt", "s3://bucket/key"] → argv[cp+1]="./local.txt" ✅
   */
  it("cp --no-cli-pager ./local.txt s3://bucket/key: correct source/dest, flag forwarded", async () => {
    const logFile = join(tmpdir(), `s3-cp-nopager-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--no-cli-pager", "./local.txt", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);   // liveness
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    // --no-cli-pager is a global passthrough flag — forwarded verbatim.
    expect(argv).toContain("--no-cli-pager");
  });

  /**
   * --debug: same regression class as --no-cli-pager.
   *
   * `s3 cp --debug ./local.txt s3://bucket/key`
   */
  it("cp --debug ./local.txt s3://bucket/key: correct source/dest", async () => {
    const logFile = join(tmpdir(), `s3-cp-debug-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--debug", "./local.txt", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    expect(argv).toContain("--debug");
  });

  /**
   * --no-paginate: same regression class.
   *
   * `s3 rm --no-paginate s3://bucket/key`
   *
   * Pre-fix: extractPositionals eats s3://bucket/key → positionals=[] → USAGE_ERROR
   * Post-fix: --no-paginate is boolean → s3://bucket/key kept → argv[rm+1] correct
   */
  it("rm --no-paginate s3://bucket/key: correct target at argv[rm+1]", async () => {
    const logFile = join(tmpdir(), `s3-rm-nopaginate-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--no-paginate", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
    expect(argv).toContain("--no-paginate");
  });

  /**
   * --no-verify-ssl: same regression class.
   */
  it("cp --no-verify-ssl s3://src/file.txt ./out.txt: correct source/dest", async () => {
    const logFile = join(tmpdir(), `s3-cp-nossl-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--no-verify-ssl", "s3://src/file.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(argv[cpIdx + 1]).toBe("s3://src/file.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
    expect(argv).toContain("--no-verify-ssl");
  });

  /**
   * Combined: global bool flag + S3 bool flag together.
   *
   * `s3 rm --no-cli-pager --dryrun s3://bucket/key`
   * → --no-cli-pager = global bool (no eat); --dryrun = S3 bool in S3_BOOL_FLAGS
   * → positionals = ["s3://bucket/key"]; dryRun=true → --dryrun IS forwarded
   */
  it("rm --no-cli-pager --dryrun s3://bucket/key: correct target, both flags forwarded", async () => {
    const logFile = join(tmpdir(), `s3-rm-nopager-dryrun-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--no-cli-pager", "--dryrun", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const rmIdx = argv.indexOf("rm");
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
    expect(argv).toContain("--no-cli-pager");
    expect(argv).toContain("--dryrun");
  });
});

// ---------------------------------------------------------------------------
// s3 cp / rm — POSIX `--` end-of-options separator
//
// Bug (9cdf100): `"--"` satisfies `arg.startsWith("--")`, is not in
// booleanFlags / GLOBAL_BOOL_FLAGS, and contains no `=`, so it falls into
// the "Unknown / value flag" branch of extractPositionals and the `i++`
// swallows the immediately following token.
//
//   s3 cp -- ./local.txt s3://bucket/key
//     [9cdf100] exit=252  child: (none)   ← token after -- eaten as "value"
//     [fixed]   exit=0    child: s3 cp ./local.txt s3://bucket/key -- …
//
// Fix: `if (arg === "--") continue;` before the unknown/value-flag branch —
// skip the separator itself without consuming what follows.
//
// Forward vs drop (ADR-0002 superset contract):
//   Real `aws` 2.33.13 accepts `--` and processes through. Base (52fc4ce)
//   forwarded it verbatim to the child. Forwarding is required to maintain
//   strict-superset input semantics: the child must see the same argv that
//   the user expressed. `--` is kept in passthrough via collectPassthroughFlags
//   (it is not in owned/bools, so it is pushed to out).
//
// RED proof: every test in this describe goes RED on 9cdf100.
//   anchor passes (baseline without --), but all `--`-bearing tests fail:
//     - primary bug: USAGE_ERROR (no child invoked → liveness assertion fails)
//     - regression guard: positional at wrong position → position assertion fails
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — POSIX `--` end-of-options separator: forwarded, does not eat next token", () => {
  /**
   * Liveness anchor: no `--` — stub must be invoked and log written.
   */
  it("anchor: stub IS invoked for s3 cp baseline (no --)", async () => {
    const logFile = join(tmpdir(), `s3-eoo-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(["cp", "./local.txt", "s3://bucket/key"], undefined, binary);

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // harness is alive
    expect(argv).toContain("./local.txt");
    expect(argv).toContain("s3://bucket/key");
  });

  /**
   * PRIMARY BUG — cp ordering 1: `--` before positionals.
   *
   * `s3 cp -- ./local.txt s3://bucket/key`
   *
   * Pre-fix (9cdf100):
   *   `--` hits unknown/value-flag branch → i++ eats `./local.txt`
   *   extractPositionals returns ["s3://bucket/key"]
   *   source="s3://bucket/key", destination=undefined → USAGE_ERROR (exit 252)
   *   child is never invoked → log absent → liveness assertion: FAIL 🔴
   *
   * Post-fix:
   *   `if (arg === "--") continue;` skips `--` without consuming `./local.txt`
   *   extractPositionals returns ["./local.txt", "s3://bucket/key"]
   *   source="./local.txt", destination="s3://bucket/key" ✅
   *   `--` forwarded to child via collectPassthroughFlags ✅
   */
  it("cp -- <src> <dst>: source/dest correct, -- forwarded to child", async () => {
    const logFile = join(tmpdir(), `s3-cp-eoo-before-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--", "./local.txt", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    // Source must be the local path, NOT undefined (USAGE_ERROR) or the S3 URI.
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    // Destination must follow source.
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    // -- must be forwarded to child (superset contract / base behaviour).
    expect(argv).toContain("--");
  });

  /**
   * Ordering 2: `--` after positionals (regression guard).
   *
   * `s3 cp ./local.txt s3://bucket/key --`
   *
   * Pre-fix: `--` is at the end; no token follows → i++ goes past end of
   * array harmlessly. Positionals are correct (accidentally). But `--` is
   * NOT forwarded to the child — it is consumed as a "value" of… nothing.
   * This test pins that after the fix `--` IS forwarded.
   *
   * Note: the test goes RED on 9cdf100 because `argv.toContain("--")`
   * fails — the current code eats `--` as a "value" sentinel (i++ on empty
   * tail) and it is lost before reaching collectPassthroughFlags.
   * (The positional positions are accidentally correct so cpIdx+1/+2 pass.)
   */
  it("cp <src> <dst> --: source/dest correct, -- forwarded to child", async () => {
    const logFile = join(tmpdir(), `s3-cp-eoo-after-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "./local.txt", "s3://bucket/key", "--"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    // -- must be forwarded to child.
    expect(argv).toContain("--");
  });

  /**
   * rm: `--` before positional.
   *
   * `s3 rm -- s3://bucket/key`
   *
   * Pre-fix (9cdf100): `--` eats `s3://bucket/key` → positionals=[] →
   * USAGE_ERROR → child never invoked → liveness FAIL 🔴
   *
   * Post-fix: positionals=["s3://bucket/key"], -- forwarded ✅
   */
  it("rm -- <uri>: target correct at argv[rm+1], -- forwarded to child", async () => {
    const logFile = join(tmpdir(), `s3-rm-eoo-before-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
    expect(argv).toContain("--");
  });

  /**
   * rm: `--` after positional (regression guard — -- forwarded).
   *
   * Pre-fix: positional is correct (accidentally) but -- not forwarded.
   * Goes RED on 9cdf100 via the `toContain("--")` assertion.
   */
  it("rm <uri> --: target correct, -- forwarded to child", async () => {
    const logFile = join(tmpdir(), `s3-rm-eoo-after-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "s3://bucket/key", "--"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
    expect(argv).toContain("--");
  });

  /**
   * Interaction: `--` combined with `--dryrun` (boolean flag).
   *
   * `s3 cp --dryrun false -- ./local.txt s3://bucket/key`
   *
   * Pre-fix (9cdf100):
   *   --dryrun + false consumed (i=0→1, skip both) → i=2 at top-of-loop
   *   `--` at i=2: unknown/value-flag → i++ eats `./local.txt` → i=4 at top
   *   `s3://bucket/key` at i=4: positional
   *   Result: ["s3://bucket/key"] → destination=undefined → USAGE_ERROR 🔴
   *
   * Post-fix:
   *   --dryrun + false consumed → `--` skipped (continue) → ./local.txt + s3://bucket/key
   *   Result: ["./local.txt", "s3://bucket/key"] ✅
   */
  it("cp --dryrun false -- <src> <dst>: source/dest correct, --dryrun absent, -- forwarded", async () => {
    const logFile = join(tmpdir(), `s3-cp-eoo-dryrun-flag-before-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--dryrun", "false", "--", "./local.txt", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    // --dryrun false → dryRun=false → not forwarded
    expect(argv).not.toContain("--dryrun");
    expect(argv).not.toContain("false");
    // -- forwarded
    expect(argv).toContain("--");
  });

  /**
   * Interaction: `--` combined with `--dryrun`, separator before positionals.
   *
   * `s3 cp -- ./local.txt s3://bucket/key --dryrun false`
   *
   * Pre-fix (9cdf100):
   *   `--` at i=0: eats `./local.txt` → i=2 at top
   *   `s3://bucket/key` at i=2: positional
   *   `--dryrun` at i=3: S3_BOOL_FLAGS → `false` → i=4, skip both
   *   Result: ["s3://bucket/key"] → destination=undefined → USAGE_ERROR 🔴
   *
   * Post-fix:
   *   `--` skipped → ./local.txt + s3://bucket/key → --dryrun false consumed ✅
   */
  it("cp -- <src> <dst> --dryrun false: source/dest correct, --dryrun absent, -- forwarded", async () => {
    const logFile = join(tmpdir(), `s3-cp-eoo-dryrun-flag-after-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--", "./local.txt", "s3://bucket/key", "--dryrun", "false"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    expect(argv).not.toContain("--dryrun");
    expect(argv).not.toContain("false");
    expect(argv).toContain("--");
  });

  /**
   * Interaction: `--` combined with `--exclude` (value flag).
   *
   * `s3 cp -- --exclude '*.log' ./local.txt s3://bucket/key`
   *
   * Pre-fix (9cdf100):
   *   `--` at i=0: unknown/value-flag → i++ eats `--exclude` → i=2 at top
   *   `*.log` at i=2: positional (WRONG — it is --exclude's value)
   *   `./local.txt` at i=3: positional
   *   `s3://bucket/key` at i=4: positional
   *   source="*.log", destination="./local.txt" → argv[cp+1]="*.log" 🔴
   *
   * Post-fix:
   *   `--` skipped → `--exclude` is value flag → eats `*.log` → ./local.txt + s3://bucket/key
   *   source="./local.txt", destination="s3://bucket/key" ✅
   *   --exclude + *.log forwarded via passthrough ✅
   */
  it("cp -- --exclude '*.log' <src> <dst>: source/dest correct, --exclude forwarded, -- forwarded", async () => {
    const logFile = join(tmpdir(), `s3-cp-eoo-exclude-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--", "--exclude", "*.log", "./local.txt", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    // Source must be ./local.txt, NOT *.log (which was the pre-fix value).
    expect(argv[cpIdx + 1]).toBe("./local.txt");
    // Destination must follow source correctly.
    expect(argv[cpIdx + 2]).toBe("s3://bucket/key");
    // --exclude and its value must survive in passthrough.
    expect(argv).toContain("--exclude");
    expect(argv).toContain("*.log");
    // -- forwarded to child.
    expect(argv).toContain("--");
  });
});

// ---------------------------------------------------------------------------
// s3 rm / s3 cp — --recursive false must NOT forward literal "false" to child
//
// Bug (#66): --recursive is absent from ownedBoolFlags in the cp/rm dispatch
// paths. collectPassthroughFlags falls back to the heuristic: the next
// non-`--` token is consumed as the flag's value, so ["--recursive","false"]
// is forwarded verbatim to the child aws, which rejects it with:
//   "Unknown options: false"
//
// Fix: add "--recursive" to ownedBoolFlags in both cp/rm collectPassthroughFlags
// calls. Re-inject bare "--recursive" when flagIsTrue(rest,"--recursive") is true.
//
// Step-0 observed child argv on main @ 9e2fec1 (pre-fix):
//   rm: ["s3","rm","s3://bucket/prefix/","--recursive","false","--output","json"]
//   cp: ["s3","cp","s3://src/","./dst/","--recursive","false","--output","json"]
//
// Both contain a literal "false" token that real `aws` rejects.
// ---------------------------------------------------------------------------

describe("wire: s3 rm/cp — --recursive false must NOT forward literal false to child (#66)", () => {
  /**
   * Liveness anchor — no flags, stub must be invoked.
   */
  it("anchor: stub IS invoked for s3 rm <uri> (no flags)", async () => {
    const logFile = join(tmpdir(), `s3-rec-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(["rm", "s3://bucket/key"], undefined, binary);

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // harness alive
    expect(argv).toContain("rm");
    expect(argv).toContain("s3://bucket/key");
  });

  /**
   * PRIMARY BUG (rm) — `--recursive false` must NOT forward "false" to child.
   *
   * Pre-fix (@9e2fec1):
   *   collectPassthroughFlags treats --recursive as unknown value-flag
   *   → heuristic consumes "false" as value
   *   → ["--recursive","false"] forwarded to child → aws rejects with
   *     "Unknown options: false"
   *   → argv contains "false"  🔴
   *
   * Post-fix:
   *   "--recursive" in ownedBoolFlags → skipped by collectPassthroughFlags
   *   flagIsTrue(...,"--recursive") = false → not re-injected
   *   → "false" absent from child argv  ✅
   *   → "--recursive" absent from child argv  ✅
   */
  it("rm --recursive false <uri>: false NOT in child argv, --recursive NOT forwarded", async () => {
    const logFile = join(tmpdir(), `s3-rm-rec-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--recursive", "false", "s3://bucket/prefix/"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    // "false" must never reach the child.
    expect(argv).not.toContain("false");
    // User said "do not recurse" → --recursive must not be forwarded.
    expect(argv).not.toContain("--recursive");
    // The target URI must still be correct.
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/prefix/");
  });

  /**
   * REGRESSION GUARD (rm) — bare `--recursive` must still reach child.
   *
   * `s3 rm --recursive s3://bucket/prefix/`
   *
   * This is the real use case: delete a prefix tree recursively.
   * After the fix, --recursive must be re-injected when flagIsTrue is true.
   */
  it("rm --recursive <uri> (bare): --recursive IS forwarded, no false in argv", async () => {
    const logFile = join(tmpdir(), `s3-rm-rec-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--recursive", "s3://bucket/prefix/"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    // --recursive must be forwarded to child (bare flag → user wants recursive delete).
    expect(argv).toContain("--recursive");
    // "false" must never appear.
    expect(argv).not.toContain("false");
    // Target URI correct.
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/prefix/");
  });

  /**
   * Equals form (rm) — `--recursive=false` must not forward false.
   */
  it("rm --recursive=false <uri>: false absent, --recursive absent", async () => {
    const logFile = join(tmpdir(), `s3-rm-rec-eqfalse-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--recursive=false", "s3://bucket/prefix/"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).not.toContain("false");
    // --recursive=false: user disabled recursion → nothing forwarded.
    expect(argv.some((t) => t.startsWith("--recursive"))).toBe(false);
  });

  /**
   * PRIMARY BUG (cp) — `--recursive false` must NOT forward "false" to child.
   *
   * Pre-fix (@9e2fec1):
   *   collectPassthroughFlags heuristic → ["--recursive","false"] forwarded
   *   → aws rejects "Unknown options: false"
   *   → argv contains "false"  🔴
   *
   * Post-fix:
   *   "--recursive" in ownedBoolFlags → stripped; flagIsTrue = false → not injected
   *   → "false" absent  ✅
   */
  it("cp --recursive false <src> <dst>: false NOT in child argv, --recursive NOT forwarded", async () => {
    const logFile = join(tmpdir(), `s3-cp-rec-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--recursive", "false", "s3://src/", "./dst/"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    expect(argv).not.toContain("false");
    expect(argv).not.toContain("--recursive");
    // Source/dest must still be correct.
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://src/");
    expect(argv[cpIdx + 2]).toBe("./dst/");
  });

  /**
   * REGRESSION GUARD (cp) — bare `--recursive` must still reach child.
   *
   * `s3 cp --recursive s3://src/ ./dst/` — copy entire directory tree.
   */
  it("cp --recursive <src> <dst> (bare): --recursive IS forwarded, no false in argv", async () => {
    const logFile = join(tmpdir(), `s3-cp-rec-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--recursive", "s3://src/", "./dst/"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0); // liveness
    expect(argv).toContain("--recursive");
    expect(argv).not.toContain("false");
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://src/");
    expect(argv[cpIdx + 2]).toBe("./dst/");
  });
});
