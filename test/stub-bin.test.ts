/**
 * Guards for the pooled stub allocator (`test/helpers/stub-bin.ts`).
 *
 * The pool trades inode churn for speed by rewriting executables in place.
 * That is only sound while two properties hold, so both are asserted here
 * against real subprocesses:
 *
 *   1. A recycled slot really is the same inode  — otherwise there is no win.
 *   2. A rewritten slot really runs the NEW bytes — otherwise tests would
 *      silently assert against a previous test's stub, which is a wrong-answer
 *      failure, not a slow one.
 *
 * Property 2 is the load-bearing one: if macOS ever served a cached image for
 * a rewritten path, every pooled test in the suite would become untrustworthy.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { stubBin, releaseStubBins, uniqueStubBin } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

/** Run a stub and capture what the child actually did. */
function run(bin: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, ["sts", "get-caller-identity"], { encoding: "utf8" }, (error, stdout) => {
      const e = error as (Error & { code?: string | number }) | null;
      resolve({ stdout: stdout.trim(), code: e ? Number(e.code ?? 1) : 0 });
    });
  });
}

const script = (out: string, exit = 0) => `#!/bin/sh\necho "${out}"\nexit ${exit}\n`;

describe("stubBin — pooled allocation", () => {
  it("recycles the same inode across release cycles (this is the whole point)", () => {
    const first = stubBin(script("A"));
    const firstIno = statSync(first).ino;

    releaseStubBins();

    const second = stubBin(script("B"));
    expect(second).toBe(first);
    expect(statSync(second).ino).toBe(firstIno);
  });

  it("runs the NEWLY written bytes after a rewrite — never a stale image", async () => {
    const first = stubBin(script("ALPHA"));
    await expect(run(first)).resolves.toEqual({ stdout: "ALPHA", code: 0 });

    releaseStubBins();

    // Same slot, different body, different exit code, and a SHORTER script —
    // the shape most likely to expose a cached executable image.
    const second = stubBin(script("Z", 3));
    expect(second).toBe(first); // same path, so this is a genuine rewrite
    await expect(run(second)).resolves.toEqual({ stdout: "Z", code: 3 });
  });

  it("hands out distinct paths to stubs held at the same time", () => {
    const a = stubBin(script("A"));
    const b = stubBin(script("B"));
    expect(a).not.toBe(b);
  });

  it("keeps the basename `aws` so argv[0] inspection still sees `aws`", () => {
    expect(basename(stubBin(script("A")))).toBe("aws");
  });

  it("two stubs live at once do not clobber each other's bodies", async () => {
    const a = stubBin(script("FIRST"));
    const b = stubBin(script("SECOND"));
    await expect(run(a)).resolves.toEqual({ stdout: "FIRST", code: 0 });
    await expect(run(b)).resolves.toEqual({ stdout: "SECOND", code: 0 });
  });
});

describe("uniqueStubBin — isolation for binary-path-keyed caches", () => {
  it("mints a distinct inode every call", () => {
    const a = uniqueStubBin(script("A"));
    const b = uniqueStubBin(script("B"));
    expect(a).not.toBe(b);
    expect(statSync(a).ino).not.toBe(statSync(b).ino);
  });

  it("is unaffected by releaseStubBins()", () => {
    const a = uniqueStubBin(script("A"));
    releaseStubBins();
    const b = uniqueStubBin(script("B"));
    expect(b).not.toBe(a);
  });
});
