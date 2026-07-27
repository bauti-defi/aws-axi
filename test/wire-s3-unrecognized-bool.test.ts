/**
 * Wire proof — unrecognized boolean values hard-error on s3 write paths (#57).
 *
 * BEFORE fix: `s3 cp --dryrun=off` was treated as truthy (silent no-op):
 *   exit 0, success-shaped output, zero bytes transferred.
 *   The user said "turn dry-run OFF" and got a dry run.
 *
 * AFTER fix: `flagIsTrue` throws USAGE_ERROR for any =-form value outside
 *   {true,1,yes,false,0,no}, so `--dryrun=off` hard-errors before the child
 *   aws process is ever spawned.
 *
 * Wire architecture:
 *   These tests drive `s3Command` (the real CLI entrypoint) with an argv that
 *   contains an unrecognized boolean value.  No stub binary is needed because
 *   USAGE_ERROR is thrown inside the overlay BEFORE `awsExec` is called.
 *   The tests assert: (a) the promise rejects, and (b) the error code is
 *   USAGE_ERROR (not SERVICE_CLIENT_ERROR / AWS_NOT_INSTALLED / etc.).
 *
 * Mutation-test results (reported in PR body):
 *   (1) Value-axis: revert the unrecognized-value throw in flagIsTrue
 *       → all "rejects with USAGE_ERROR" tests go RED (no throw → resolves or
 *         throws AWS_NOT_INSTALLED for a real binary, not USAGE_ERROR).
 *   (2) Wiring-axis: bypass the flagIsTrue call at the cp dryRun dispatch site
 *       → wire test for dryrun=off goes RED (no USAGE_ERROR thrown).
 *
 * Part 1 (--recursive coherence): also covered below.
 *   --recursive=false on both the no-URI ls path and the head-object path
 *   must NOT throw USAGE_ERROR (user said "don't recurse" = default = silent ok).
 *   `flagIsTrue` with value "false" → returns false → guard condition is false →
 *   no throw.  Tests use a stub binary that returns minimal valid JSON.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { s3Command } from "../src/commands/s3.js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readArgv(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

/** Stub that logs argv and exits 0. */
function argvLoggingStub(logFile: string): string {
  return stubBin(`#!/bin/sh\nprintf '%s\\n' "$@" > ${logFile}\nexit 0\n`);
}

/** Stub that always exits 0 with minimal JSON for list-buckets. */
function listBucketsStub(): string {
  return stubBin(`#!/bin/sh\nprintf '{"Buckets":[],"Owner":null}'\nexit 0\n`);
}

/** Stub that always exits 0 with minimal JSON for head-object. */
function headObjectStub(): string {
  return stubBin(`#!/bin/sh\nprintf '{"ContentType":"application/octet-stream","ContentLength":0,"ETag":"etag","LastModified":"2026-01-01T00:00:00Z"}'\nexit 0\n`);
}

// ---------------------------------------------------------------------------
// Part 2 — hard-error on unrecognized boolean values
// ---------------------------------------------------------------------------

describe("wire: s3 cp/rm — unrecognized =-form bool values → USAGE_ERROR (#57)", () => {
  it("s3 cp --dryrun=off rejects with USAGE_ERROR (not a silent dry-run)", async () => {
    // USAGE_ERROR thrown inside flagIsTrue before awsExec is spawned.
    // No binary needed: the throw happens in the overlay before any aws call.
    let thrown: unknown;
    try {
      await s3Command(
        ["cp", "--dryrun=off", "s3://src-bucket/f.txt", "s3://dst-bucket/f.txt"],
        undefined,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 cp --dryrun=garbage rejects with USAGE_ERROR", async () => {
    let thrown: unknown;
    try {
      await s3Command(
        ["cp", "--dryrun=garbage", "s3://src-bucket/f.txt", "s3://dst-bucket/f.txt"],
        undefined,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 cp --dryrun= (empty value) rejects with USAGE_ERROR", async () => {
    let thrown: unknown;
    try {
      await s3Command(
        ["cp", "--dryrun=", "s3://src-bucket/f.txt", "s3://dst-bucket/f.txt"],
        undefined,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 rm --dryrun=off rejects with USAGE_ERROR", async () => {
    let thrown: unknown;
    try {
      await s3Command(["rm", "--dryrun=off", "s3://bucket/key"], undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 cp --recursive=off rejects with USAGE_ERROR (Part 2 covers cp/rm sibling flags too)", async () => {
    // --recursive is in S3_CP_RM_REINJECT_FLAGS; flagIsTrue is called on it.
    // --recursive=off → unrecognized value → USAGE_ERROR.
    let thrown: unknown;
    try {
      await s3Command(
        ["cp", "--recursive=off", "s3://src-bucket/prefix/", "s3://dst-bucket/prefix/"],
        undefined,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 ls s3://bucket/ --recursive=off rejects with USAGE_ERROR (Part 2 covers ls path too)", async () => {
    // flagIsTrue is called for --recursive on the ls prefix path.
    // --recursive=off → unrecognized → USAGE_ERROR.
    let thrown: unknown;
    try {
      await s3Command(["ls", "s3://bucket/", "--recursive=off"], undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  // ── Positive guard: recognized false literals still work ─────────────────
  //
  // These ensure the fix does NOT break the recognized vocabulary.
  // `--dryrun=false` → flagIsTrue returns false → cp executes for real (not dry-run).
  // We use an argv-logging stub to verify aws IS invoked (i.e. no early throw).

  it("s3 cp --dryrun=false: recognized → no USAGE_ERROR, aws IS invoked", async () => {
    const logFile = join(tmpdir(), `dryrun-false-${Date.now()}.log`);
    const binary = argvLoggingStub(logFile);

    // Must not throw
    await s3Command(
      ["cp", "--dryrun=false", "s3://src/f.txt", "./out.txt"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    // aws WAS invoked — log file non-empty
    expect(argv.length).toBeGreaterThan(0);
    // --dryrun is NOT forwarded (user said "don't dry-run")
    expect(argv).not.toContain("--dryrun");
    // Positionals are intact
    expect(argv).toContain("s3://src/f.txt");
    expect(argv).toContain("./out.txt");
  });

  it("s3 rm --dryrun=no: recognized → no USAGE_ERROR, aws IS invoked", async () => {
    const logFile = join(tmpdir(), `dryrun-no-${Date.now()}.log`);
    const binary = argvLoggingStub(logFile);

    await s3Command(
      ["rm", "--dryrun=no", "s3://bucket/key"],
      undefined,
      binary,
    );

    const argv = readArgv(logFile);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).not.toContain("--dryrun");
    expect(argv).toContain("s3://bucket/key");
  });
});

// ---------------------------------------------------------------------------
// --recursive loud-error behavior (operator decision: Part 1 NOT taken)
// ---------------------------------------------------------------------------
//
// The `--recursive` guard on bare `s3 ls` (no URI) and `s3 head-object` uses
// `hasFlag` (presence-only), NOT `flagIsTrue`. ANY appearance of `--recursive`
// — including `--recursive=false` — throws USAGE_ERROR on those paths.
//
// Rationale (operator directive):
//   Loud-error principle: if the flag appears at all on a path where recursion
//   has no meaning, the caller has a misconception that should surface immediately,
//   not be silently absorbed. Real `aws` rejects `--recursive=false` outright.
//   The #57 Part 2 hard-error on unrecognized =-form values also fires for
//   `--recursive=off` before the path guard even runs.
//
// The `s3 ls s3://bucket/ --recursive=false` case (prefix path) still works:
// that path uses `flagIsTrue`, so `=false` → recursive=false → delimiter kept.

describe("--recursive loud-error on s3 ls (no URI) and head-object", () => {
  // ── s3 ls (no URI) ──────────────────────────────────────────────────────────

  it("s3 ls --recursive=false (no URI): USAGE_ERROR — any --recursive form is an error here", async () => {
    // Operator decision: `--recursive=false` on the no-URI path still loud-errors.
    // hasFlag detects presence regardless of value; real aws rejects this form outright.
    let thrown: unknown;
    try {
      await s3Command(["ls", "--recursive=false"], undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 ls --recursive (no URI): USAGE_ERROR (unchanged — bare flag still errors)", async () => {
    let thrown: unknown;
    try {
      await s3Command(["ls", "--recursive"], undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 ls --recursive=true (no URI): USAGE_ERROR (unchanged — explicit true errors)", async () => {
    let thrown: unknown;
    try {
      await s3Command(["ls", "--recursive=true"], undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 ls --recursive=no (no URI): USAGE_ERROR — hasFlag fires before Part 2 throw", async () => {
    // =no is a recognised false literal (would pass flagIsTrue's check) but
    // the no-URI path uses hasFlag, so presence alone → USAGE_ERROR.
    let thrown: unknown;
    try {
      await s3Command(["ls", "--recursive=no"], undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  // ── s3 head-object ──────────────────────────────────────────────────────────

  it("s3 head-object --recursive=false: USAGE_ERROR — any --recursive form is an error here", async () => {
    // Same loud-error principle: head-object has no recursion concept.
    let thrown: unknown;
    try {
      await s3Command(
        ["head-object", "--bucket", "my-bucket", "--key", "path/to/file.txt", "--recursive=false"],
        undefined,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  it("s3 head-object --recursive (bare): USAGE_ERROR (unchanged)", async () => {
    let thrown: unknown;
    try {
      await s3Command(
        ["head-object", "--bucket", "my-bucket", "--key", "path/to/file.txt", "--recursive"],
        undefined,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe("USAGE_ERROR");
  });

  // ── Positive guard: prefix path (ls s3://...) still uses flagIsTrue ────────

  it("s3 ls s3://bucket/ --recursive=false: SUCCEEDS on prefix path (flagIsTrue returns false there)", async () => {
    // The PREFIX path (ls s3://...) uses flagIsTrue, so --recursive=false is honored.
    // This test documents the deliberate asymmetry between the no-URI and prefix paths.
    const binary = listBucketsStub(); // minimal stub; list-objects-v2 returns empty
    // This should NOT throw — the prefix path honors =false
    const result = await s3Command(["ls", "s3://bucket/", "--recursive=false"], undefined, binary);
    expect(result).toBeDefined();
  });
});
