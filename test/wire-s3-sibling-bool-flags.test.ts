/**
 * Wire harness: PATH-shim `aws` + real CLI entrypoint.
 *
 * Proves that four sibling boolean flags on `s3 cp` and `s3 rm` correctly
 * suppress literal `false` from the child `aws` argv (fixing #84), and that
 * the bare flag IS forwarded when the user enables them.
 *
 * Flags covered: --quiet, --only-show-errors, --no-progress, --follow-symlinks
 *
 * Test matrix: 4 flags × {cp, rm} × {false=drop, true=inject} = 16 core cases
 * plus 2 liveness anchors = 18 total.
 *
 * Architecture:
 *   - A PATH-shim `aws` script writes every argv token (one per line) to a
 *     temp file, then exits 0. Assertions are on the LITERAL ARGV that reached
 *     the child process.
 *   - `s3Command(args, undefined, binary)` drives the real CLI entrypoint.
 *
 * Pre-fix RED proof:
 *   With main @ caafa8a (before this fix), all "false case" tests fail:
 *   argv contains both the flag AND the literal "false" → aws would reject
 *   with "Unknown options: false". After the fix, all go GREEN.
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

const tempDirs: string[] = [];

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
// Stub factory (mirrors wire-s3-positional.test.ts)
// ---------------------------------------------------------------------------

function createArgvLoggingStub(logFile: string): string {
  return stubBin(`#!/bin/sh\nprintf '%s\\n' "$@" > ${logFile}\nexit 0\n`);
}

function readArgv(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the child never received the literal string "false". */
function expectNoFalseLiteral(argv: string[]): void {
  expect(argv).not.toContain("false");
}

/** Assert a flag is NOT forwarded to the child. */
function expectFlagAbsent(argv: string[], flag: string): void {
  expect(argv).not.toContain(flag);
}

/** Assert a flag IS forwarded to the child. */
function expectFlagPresent(argv: string[], flag: string): void {
  expect(argv).toContain(flag);
}

// ---------------------------------------------------------------------------
// Liveness anchors
// ---------------------------------------------------------------------------

describe("wire: s3 sibling bool flags — liveness anchors", () => {
  it("anchor: stub IS invoked for s3 cp (log file non-empty)", async () => {
    const logFile = join(tmpdir(), `sibling-cp-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(["cp", "s3://bucket/src.txt", "./out.txt"], undefined, binary);

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain("s3");
    expect(argv).toContain("s3://bucket/src.txt");
    expect(argv).toContain("./out.txt");
  });

  it("anchor: stub IS invoked for s3 rm (log file non-empty)", async () => {
    const logFile = join(tmpdir(), `sibling-rm-anchor-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(["rm", "s3://bucket/key"], undefined, binary);

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).toContain("s3");
    expect(argv).toContain("rm");
    expect(argv).toContain("s3://bucket/key");
  });
});

// ---------------------------------------------------------------------------
// --quiet × {cp, rm} × {false, true}
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — --quiet false must NOT forward literal false (#84)", () => {
  it("cp --quiet false <src> <dst>: false absent, --quiet absent", async () => {
    const logFile = join(tmpdir(), `sibling-cp-quiet-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--quiet", "false", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);                   // liveness
    expectNoFalseLiteral(argv);                                // "false" must NOT reach aws
    expectFlagAbsent(argv, "--quiet");                         // user said "do not be quiet"
    // positionals must survive
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("cp --quiet <src> <dst> (bare/true): --quiet IS forwarded, false absent", async () => {
    const logFile = join(tmpdir(), `sibling-cp-quiet-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--quiet", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--quiet");                        // bare → user wants quiet
    expectNoFalseLiteral(argv);
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("rm --quiet false <uri>: false absent, --quiet absent", async () => {
    const logFile = join(tmpdir(), `sibling-rm-quiet-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--quiet", "false", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--quiet");
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });

  it("rm --quiet <uri> (bare/true): --quiet IS forwarded, false absent", async () => {
    const logFile = join(tmpdir(), `sibling-rm-quiet-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--quiet", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--quiet");
    expectNoFalseLiteral(argv);
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });
});

// ---------------------------------------------------------------------------
// --only-show-errors × {cp, rm} × {false, true}
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — --only-show-errors false must NOT forward literal false (#84)", () => {
  it("cp --only-show-errors false <src> <dst>: false absent, --only-show-errors absent", async () => {
    const logFile = join(tmpdir(), `sibling-cp-ose-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--only-show-errors", "false", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--only-show-errors");
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("cp --only-show-errors <src> <dst> (bare/true): --only-show-errors IS forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-cp-ose-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--only-show-errors", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--only-show-errors");
    expectNoFalseLiteral(argv);
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("rm --only-show-errors false <uri>: false absent, --only-show-errors absent", async () => {
    const logFile = join(tmpdir(), `sibling-rm-ose-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--only-show-errors", "false", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--only-show-errors");
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });

  it("rm --only-show-errors <uri> (bare/true): --only-show-errors IS forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-rm-ose-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--only-show-errors", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--only-show-errors");
    expectNoFalseLiteral(argv);
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });
});

// ---------------------------------------------------------------------------
// --no-progress × {cp, rm} × {false, true}
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — --no-progress false must NOT forward literal false (#84)", () => {
  it("cp --no-progress false <src> <dst>: false absent, --no-progress absent", async () => {
    const logFile = join(tmpdir(), `sibling-cp-np-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--no-progress", "false", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--no-progress");
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("cp --no-progress <src> <dst> (bare/true): --no-progress IS forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-cp-np-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--no-progress", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--no-progress");
    expectNoFalseLiteral(argv);
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("rm --no-progress false <uri>: false absent, --no-progress absent", async () => {
    const logFile = join(tmpdir(), `sibling-rm-np-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--no-progress", "false", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--no-progress");
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });

  it("rm --no-progress <uri> (bare/true): --no-progress IS forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-rm-np-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--no-progress", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--no-progress");
    expectNoFalseLiteral(argv);
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });
});

// ---------------------------------------------------------------------------
// --follow-symlinks × {cp, rm} × {false, true}
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — --follow-symlinks false must NOT forward literal false (#84)", () => {
  it("cp --follow-symlinks false <src> <dst>: false absent, --follow-symlinks absent", async () => {
    const logFile = join(tmpdir(), `sibling-cp-fs-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--follow-symlinks", "false", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--follow-symlinks");
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("cp --follow-symlinks <src> <dst> (bare/true): --follow-symlinks IS forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-cp-fs-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--follow-symlinks", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--follow-symlinks");
    expectNoFalseLiteral(argv);
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("rm --follow-symlinks false <uri>: false absent, --follow-symlinks absent", async () => {
    const logFile = join(tmpdir(), `sibling-rm-fs-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--follow-symlinks", "false", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--follow-symlinks");
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });

  it("rm --follow-symlinks <uri> (bare/true): --follow-symlinks IS forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-rm-fs-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--follow-symlinks", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--follow-symlinks");
    expectNoFalseLiteral(argv);
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/key");
  });
});

// ---------------------------------------------------------------------------
// Cross-flag regression: combining multiple sibling bool flags
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — multiple sibling bool flags together", () => {
  it("cp --quiet false --no-progress false <src> <dst>: neither flag nor false forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-cp-multi-false-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["cp", "--quiet", "false", "--no-progress", "false", "s3://bucket/src.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectNoFalseLiteral(argv);
    expectFlagAbsent(argv, "--quiet");
    expectFlagAbsent(argv, "--no-progress");
    const cpIdx = argv.indexOf("cp");
    expect(cpIdx).toBeGreaterThanOrEqual(0);
    expect(argv[cpIdx + 1]).toBe("s3://bucket/src.txt");
    expect(argv[cpIdx + 2]).toBe("./out.txt");
  });

  it("rm --quiet --only-show-errors s3://bucket/prefix/ --recursive: all flags forwarded", async () => {
    const logFile = join(tmpdir(), `sibling-rm-multi-bare-${Date.now()}.log`);
    const binary = createArgvLoggingStub(logFile);

    await s3Command(
      ["rm", "--quiet", "--only-show-errors", "s3://bucket/prefix/", "--recursive"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expectFlagPresent(argv, "--quiet");
    expectFlagPresent(argv, "--only-show-errors");
    expectFlagPresent(argv, "--recursive");
    expectNoFalseLiteral(argv);
    const rmIdx = argv.indexOf("rm");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(argv[rmIdx + 1]).toBe("s3://bucket/prefix/");
  });
});
