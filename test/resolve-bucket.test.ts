/**
 * E2E tests for the resolve-bucket primitive through a real stub aws binary.
 * No mocks — the full exec seam runs at a subprocess boundary.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBucket } from "../src/resolve/bucket.js";
import { AxiError } from "axi-sdk-js";

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-resolve-bucket-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");

  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }

  const lines = [
    "#!/bin/sh",
    spec.stdout !== undefined
      ? `printf '%s' ${shellQuote(spec.stdout)}`
      : "",
    spec.stderr !== undefined
      ? `printf '%s' ${shellQuote(spec.stderr)} >&2`
      : "",
    `exit ${spec.exitCode ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");

  writeFileSync(p, lines);
  chmodSync(p, 0o755);
  return p;
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
// resolveBucket
// ---------------------------------------------------------------------------

describe("resolveBucket", () => {
  it("returns exists=true when head-bucket succeeds", async () => {
    // head-bucket returns empty JSON on success
    const stub = createStub({ stdout: "{}", exitCode: 0 });
    const info = await resolveBucket({ bucket: "my-bucket", binary: stub });

    expect(info.exists).toBe(true);
  });

  it("returns exists=false for NoSuchBucket error", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (NoSuchBucket) when calling the HeadBucket operation: The specified bucket does not exist",
      exitCode: 255,
    });
    const info = await resolveBucket({
      bucket: "missing-bucket",
      binary: stub,
    });

    expect(info.exists).toBe(false);
  });

  it("returns exists=false for 404 NoSuchBucket variant", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (404) when calling the HeadBucket operation: Not Found",
      exitCode: 255,
    });
    const info = await resolveBucket({
      bucket: "missing-bucket-2",
      binary: stub,
    });

    expect(info.exists).toBe(false);
  });

  it("propagates AxiError for non-NoSuchBucket errors (e.g. AccessDenied)", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (AccessDenied) when calling the HeadBucket operation: Access Denied",
      exitCode: 255,
    });

    await expect(
      resolveBucket({ bucket: "forbidden-bucket", binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);

    const stub2 = createStub({
      stdout: "",
      stderr:
        "An error occurred (AccessDenied) when calling the HeadBucket operation: Access Denied",
      exitCode: 255,
    });
    try {
      await resolveBucket({ bucket: "forbidden-bucket", binary: stub2 });
    } catch (e) {
      expect((e as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    }
  });

  it("returns cached result on second call with same key", async () => {
    // First stub: success
    const stub = createStub({ stdout: "{}", exitCode: 0 });

    const first = await resolveBucket({
      bucket: "cached-bucket",
      binary: stub,
    });
    // Second call with a DIFFERENT binary that would fail — proves cache hit
    const failBinary = "/nonexistent/path/to/aws";
    const second = await resolveBucket({
      bucket: "cached-bucket",
      binary: failBinary, // this would throw if called — cache prevents it
    });

    expect(first.exists).toBe(true);
    expect(second.exists).toBe(true);
  });
});
