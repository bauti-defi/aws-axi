/**
 * E2E tests for the s3 command through a real stub aws binary.
 * No mocks — the full exec seam runs with a subprocess boundary.
 *
 * Stubs emit pinned S3 outputs so tests are deterministic without
 * live AWS credentials. No real buckets are created or deleted.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  s3LsRun,
  s3HeadObjectRun,
  s3CreateBucketRun,
  s3CpRun,
  s3RmRun,
  S3_PAGE_SIZE,
} from "../src/commands/s3.js";
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
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-"));
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
// s3LsRun — list buckets (no prefix)
// ---------------------------------------------------------------------------

const LIST_BUCKETS_RESPONSE = JSON.stringify({
  Buckets: [
    { Name: "alpha-bucket", CreationDate: "2023-01-15T10:30:00+00:00" },
    { Name: "beta-bucket", CreationDate: "2023-06-20T08:00:00+00:00" },
  ],
  Owner: { DisplayName: "me", ID: "abc123def456" },
});

const EMPTY_BUCKETS_RESPONSE = JSON.stringify({
  Buckets: [],
  Owner: { DisplayName: "me", ID: "abc123def456" },
});

describe("s3LsRun — list buckets (no S3 URI)", () => {
  it("returns a compact bucket listing with name and creationDate", async () => {
    const stub = createStub({ stdout: LIST_BUCKETS_RESPONSE, exitCode: 0 });
    const result = await s3LsRun({ binary: stub });

    expect(result.buckets).toBeDefined();
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets![0]).toMatchObject({
      name: "alpha-bucket",
      creationDate: "2023-01-15T10:30:00+00:00",
    });
    expect(result.buckets![1]).toMatchObject({
      name: "beta-bucket",
      creationDate: "2023-06-20T08:00:00+00:00",
    });
  });

  it("returns empty-state info when no buckets exist", async () => {
    const stub = createStub({ stdout: EMPTY_BUCKETS_RESPONSE, exitCode: 0 });
    const result = await s3LsRun({ binary: stub });

    expect(result.buckets).toHaveLength(0);
    expect(result.empty).toBe(true);
    expect(result.hint).toMatch(/create-bucket/i);
  });
});

// ---------------------------------------------------------------------------
// s3LsRun — list objects (with S3 URI prefix)
// ---------------------------------------------------------------------------

/** Build a list-objects-v2 response with N items. */
function buildObjectsResponse(opts: {
  keys: string[];
  isTruncated: boolean;
  nextToken?: string;
  bucket?: string;
  prefix?: string;
}): string {
  return JSON.stringify({
    Contents: opts.keys.map((key, i) => ({
      Key: key,
      Size: (i + 1) * 1024,
      LastModified: "2023-11-01T10:00:00+00:00",
      ETag: `"etag${i}"`,
      StorageClass: "STANDARD",
    })),
    KeyCount: opts.keys.length,
    MaxKeys: S3_PAGE_SIZE,
    IsTruncated: opts.isTruncated,
    ...(opts.nextToken ? { NextToken: opts.nextToken } : {}),
    Name: opts.bucket ?? "my-bucket",
    Prefix: opts.prefix ?? "",
  });
}

describe("s3LsRun — list objects (with S3 URI)", () => {
  it("returns a compact object listing with key, size, lastModified", async () => {
    const response = buildObjectsResponse({
      keys: ["logs/app.log", "logs/error.log"],
      isTruncated: false,
    });
    const stub = createStub({ stdout: response, exitCode: 0 });
    const result = await s3LsRun({
      prefix: "s3://my-bucket/logs/",
      binary: stub,
    });

    expect(result.objects).toHaveLength(2);
    expect(result.objects![0]).toMatchObject({
      key: "logs/app.log",
      size: 1024,
      lastModified: "2023-11-01T10:00:00+00:00",
    });
    expect(result.truncated).toBe(false);
  });

  it("reports truncation honestly when IsTruncated=true", async () => {
    const keys = Array.from({ length: S3_PAGE_SIZE }, (_, i) => `file${i}.txt`);
    const response = buildObjectsResponse({
      keys,
      isTruncated: true,
      nextToken: "eyJNYXJrZXIiOiBudWxsfQ==",
    });
    const stub = createStub({ stdout: response, exitCode: 0 });
    const result = await s3LsRun({
      prefix: "s3://my-bucket/",
      binary: stub,
    });

    expect(result.objects).toHaveLength(S3_PAGE_SIZE);
    expect(result.truncated).toBe(true);
    expect(result.nextToken).toBe("eyJNYXJrZXIiOiBudWxsfQ==");
    expect(result.hint).toMatch(/--starting-token/i);
  });

  it("returns empty-state info when no objects match the prefix", async () => {
    const response = JSON.stringify({
      Contents: [],
      KeyCount: 0,
      MaxKeys: S3_PAGE_SIZE,
      IsTruncated: false,
      Name: "my-bucket",
      Prefix: "nonexistent/",
    });
    const stub = createStub({ stdout: response, exitCode: 0 });
    const result = await s3LsRun({
      prefix: "s3://my-bucket/nonexistent/",
      binary: stub,
    });

    expect(result.objects).toHaveLength(0);
    expect(result.empty).toBe(true);
    expect(result.hint).toMatch(/no objects/i);
  });

  it("passes --starting-token when startingToken option provided", async () => {
    // Stub that echoes its args so we can inspect them.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-args-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(p, `#!/bin/sh\necho "$@"\nexit 0`);
    chmodSync(p, 0o755);

    const result = await s3LsRun({
      prefix: "s3://my-bucket/",
      startingToken: "TOKEN123",
      binary: p,
    }).catch(() => null); // stdout won't be valid JSON; we only care args were echoed

    // The args check is done by inspecting stdout (which the stub echoes),
    // so we run it a different way: use a stub that checks for the flag.
    const dir2 = mkdtempSync(join(tmpdir(), "aws-axi-s3-args2-"));
    tempDirs.push(dir2);
    const p2 = join(dir2, "aws");
    writeFileSync(
      p2,
      `#!/bin/sh
if echo "$@" | grep -q "starting-token"; then
  printf '{"Contents":[],"KeyCount":0,"MaxKeys":20,"IsTruncated":false,"Name":"my-bucket","Prefix":""}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(p2, 0o755);

    const result2 = await s3LsRun({
      prefix: "s3://my-bucket/",
      startingToken: "TOKEN123",
      binary: p2,
    });
    expect(result2.empty).toBe(true);
    void result; // suppress unused-var warning
  });
});

// ---------------------------------------------------------------------------
// s3HeadObjectRun
// ---------------------------------------------------------------------------

const HEAD_OBJECT_RESPONSE = JSON.stringify({
  ContentType: "application/json",
  ContentLength: 2048,
  ETag: '"abc123def456"',
  LastModified: "2023-11-15T12:00:00+00:00",
  Metadata: { author: "alice" },
  StorageClass: "STANDARD",
});

describe("s3HeadObjectRun", () => {
  it("returns metadata: contentType, contentLength, etag, lastModified", async () => {
    const stub = createStub({ stdout: HEAD_OBJECT_RESPONSE, exitCode: 0 });
    const result = await s3HeadObjectRun({
      bucket: "my-bucket",
      key: "data/payload.json",
      binary: stub,
    });

    expect(result.contentType).toBe("application/json");
    expect(result.contentLength).toBe(2048);
    expect(result.etag).toBe('"abc123def456"');
    expect(result.lastModified).toBe("2023-11-15T12:00:00+00:00");
  });

  it("throws SERVICE_CLIENT_ERROR when object does not exist", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (404) when calling the HeadObject operation: Not Found",
      exitCode: 255,
    });

    await expect(
      s3HeadObjectRun({ bucket: "my-bucket", key: "missing.txt", binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);
  });
});

// ---------------------------------------------------------------------------
// s3CreateBucketRun — idempotent
// ---------------------------------------------------------------------------

describe("s3CreateBucketRun — idempotent create", () => {
  it("returns created=true on fresh bucket creation (us-east-1 explicit)", async () => {
    // us-east-1: no LocationConstraint, no configure-get-region call needed.
    const stub = createStub({
      stdout: JSON.stringify({ Location: "/fresh-bucket" }),
      exitCode: 0,
    });
    const result = await s3CreateBucketRun({
      bucket: "fresh-bucket",
      region: "us-east-1",
      binary: stub,
    });

    expect(result.created).toBe(true);
    expect(result.bucket).toBe("fresh-bucket");
    expect(result.idempotent).toBe(false);
  });

  it("treats BucketAlreadyOwnedByYou as idempotent success", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (BucketAlreadyOwnedByYou) when calling the CreateBucket operation: Your previous request to create the named bucket succeeded and you already own it.",
      exitCode: 255,
    });
    // Pass region explicitly so configure-get-region is not called — the stub
    // would otherwise interpret the configure call as BucketAlreadyOwnedByYou.
    const result = await s3CreateBucketRun({
      bucket: "existing-owned-bucket",
      region: "us-east-1",
      binary: stub,
    });

    expect(result.created).toBe(false);
    expect(result.idempotent).toBe(true);
    expect(result.bucket).toBe("existing-owned-bucket");
  });

  it("throws SERVICE_CLIENT_ERROR for BucketAlreadyExists (owned by others)", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (BucketAlreadyExists) when calling the CreateBucket operation: The requested bucket name is not available.",
      exitCode: 255,
    });

    await expect(
      s3CreateBucketRun({ bucket: "taken-bucket", region: "us-east-1", binary: stub }),
    ).rejects.toBeInstanceOf(AxiError);

    const stub2 = createStub({
      stdout: "",
      stderr:
        "An error occurred (BucketAlreadyExists) when calling the CreateBucket operation: The requested bucket name is not available.",
      exitCode: 255,
    });

    try {
      await s3CreateBucketRun({ bucket: "taken-bucket", region: "us-east-1", binary: stub2 });
    } catch (e) {
      expect((e as AxiError).code).toBe("SERVICE_CLIENT_ERROR");
    }
  });

  it("emits LocationConstraint when --region is specified and not us-east-1", async () => {
    // The stub FAILS if create-bucket-configuration is absent, proving the
    // LocationConstraint IS emitted for non-us-east-1 explicit --region.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-loc-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q "LocationConstraint=eu-west-1"; then
  printf '{"Location":"/region-bucket"}'
  exit 0
fi
printf 'An error occurred (IllegalLocationConstraintException) when calling the CreateBucket operation: Missing LocationConstraint.' >&2
exit 255
`,
    );
    chmodSync(p, 0o755);

    const result = await s3CreateBucketRun({
      bucket: "region-bucket",
      region: "eu-west-1",
      binary: p,
    });
    expect(result.created).toBe(true);
  });

  it("emits LocationConstraint when region is resolved from profile config (no argv/env region)", async () => {
    // Stub dispatches on args:
    //   configure get region → returns "eu-west-2"
    //   create-bucket with LocationConstraint=eu-west-2 → success
    //   create-bucket without LocationConstraint → failure (proves the constraint was added)
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-cfg-region-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q "configure get region"; then
  printf 'eu-west-2'
  exit 0
fi
if echo "$@" | grep -q "LocationConstraint=eu-west-2"; then
  printf '{"Location":"/cfg-region-bucket"}'
  exit 0
fi
printf 'An error occurred (IllegalLocationConstraintException) when calling the CreateBucket operation: Missing or wrong LocationConstraint.' >&2
exit 255
`,
    );
    chmodSync(p, 0o755);

    // No options.region, no context.region — must fall back to configure get region.
    const result = await s3CreateBucketRun({
      bucket: "cfg-region-bucket",
      binary: p,
    });
    expect(result.created).toBe(true);
    expect(result.bucket).toBe("cfg-region-bucket");
  });

  it("omits LocationConstraint when profile config region is us-east-1", async () => {
    // Stub: configure get region → "us-east-1"; create-bucket WITHOUT constraint → success.
    // If LocationConstraint is (wrongly) added, the stub returns an error.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-use1-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q "configure get region"; then
  printf 'us-east-1'
  exit 0
fi
if echo "$@" | grep -q "create-bucket-configuration"; then
  printf 'An error occurred (InvalidLocationConstraint) when calling the CreateBucket operation: us-east-1 must not have LocationConstraint.' >&2
  exit 255
fi
printf '{"Location":"/us-east-1-bucket"}'
exit 0
`,
    );
    chmodSync(p, 0o755);

    const result = await s3CreateBucketRun({
      bucket: "us-east-1-bucket",
      binary: p,
    });
    expect(result.created).toBe(true);
  });

  it("throws USAGE_ERROR when no region can be determined from any source", async () => {
    // Stub: configure get region exits 1 (not configured); create-bucket never reached.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-no-region-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q "configure get region"; then
  exit 1
fi
exit 1
`,
    );
    chmodSync(p, 0o755);

    await expect(
      s3CreateBucketRun({ bucket: "no-region-bucket", binary: p }),
    ).rejects.toBeInstanceOf(AxiError);

    const dir2 = mkdtempSync(join(tmpdir(), "aws-axi-s3-no-region2-"));
    tempDirs.push(dir2);
    const p2 = join(dir2, "aws");
    writeFileSync(p2, `#!/bin/sh\nif echo "$@" | grep -q "configure get region"; then\n  exit 1\nfi\nexit 1`);
    chmodSync(p2, 0o755);

    try {
      await s3CreateBucketRun({ bucket: "no-region-bucket-2", binary: p2 });
    } catch (e) {
      expect((e as AxiError).code).toBe("USAGE_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
// s3CpRun
// ---------------------------------------------------------------------------

describe("s3CpRun", () => {
  it("returns success with source and destination on copy", async () => {
    const stub = createStub({
      stdout: "copy: s3://src-bucket/file.txt to s3://dst-bucket/file.txt\n",
      exitCode: 0,
    });
    const result = await s3CpRun({
      source: "s3://src-bucket/file.txt",
      destination: "s3://dst-bucket/file.txt",
      binary: stub,
    });

    expect(result.source).toBe("s3://src-bucket/file.txt");
    expect(result.destination).toBe("s3://dst-bucket/file.txt");
    expect(result.dryRun).toBe(false);
  });

  it("returns dryRun=true and does not copy when --dryrun passed", async () => {
    const stub = createStub({
      stdout:
        "(dryrun) copy: s3://src-bucket/file.txt to s3://dst-bucket/file.txt\n",
      exitCode: 0,
    });
    const result = await s3CpRun({
      source: "s3://src-bucket/file.txt",
      destination: "s3://dst-bucket/file.txt",
      dryRun: true,
      binary: stub,
    });

    expect(result.dryRun).toBe(true);
  });

  it("throws AxiError on copy failure", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (NoSuchBucket) when calling the GetObject operation: The specified bucket does not exist",
      exitCode: 1,
    });

    await expect(
      s3CpRun({
        source: "s3://missing-bucket/file.txt",
        destination: "s3://dst-bucket/file.txt",
        binary: stub,
      }),
    ).rejects.toBeInstanceOf(AxiError);
  });
});

// ---------------------------------------------------------------------------
// s3RmRun
// ---------------------------------------------------------------------------

describe("s3RmRun", () => {
  it("returns success with the deleted object path", async () => {
    const stub = createStub({
      stdout: "delete: s3://my-bucket/old-file.txt\n",
      exitCode: 0,
    });
    const result = await s3RmRun({
      target: "s3://my-bucket/old-file.txt",
      binary: stub,
    });

    expect(result.target).toBe("s3://my-bucket/old-file.txt");
    expect(result.dryRun).toBe(false);
  });

  it("returns dryRun=true when --dryrun passed", async () => {
    const stub = createStub({
      stdout: "(dryrun) delete: s3://my-bucket/old-file.txt\n",
      exitCode: 0,
    });
    const result = await s3RmRun({
      target: "s3://my-bucket/old-file.txt",
      dryRun: true,
      binary: stub,
    });

    expect(result.dryRun).toBe(true);
  });
});
