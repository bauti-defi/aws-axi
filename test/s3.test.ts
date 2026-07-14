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
  s3Command,
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

// ---------------------------------------------------------------------------
// s3Command — equals-form regression tests (ADR-0002 compliance)
//
// These tests prove that the equals form (--flag=value) is correctly parsed
// at the s3Command dispatch layer.  The old private parseFlag/hasFlag in s3.ts
// used indexOf/includes (exact-token match only), which made equals-form inputs
// either silently drop the flag or hard-reject valid input.
//
// RED for the old code:
//   head-object --bucket=b --key=k  → USAGE_ERROR ("requires --bucket and --key")
//   create-bucket --bucket=b        → USAGE_ERROR ("requires --bucket")
//   ls --starting-token=TOK         → token silently dropped; GET / returned
//   ls --bucket-name-prefix=foo     → prefix silently dropped; all buckets returned
//
// GREEN after this fix: extractFlag (overlay-args) handles both forms.
// ---------------------------------------------------------------------------

describe("s3Command — equals-form flag parsing (ADR-0002 compliance)", () => {
  // ── head-object --bucket=b --key=k ─────────────────────────────────────────
  it("head-object with --bucket=b --key=k is not hard-rejected (equals form)", async () => {
    // Stub returns a valid head-object response so s3HeadObjectRun does not fail.
    const stub = createStub({ stdout: HEAD_OBJECT_RESPONSE, exitCode: 0 });

    // RED if extractFlag is not used: old parseFlag(indexOf) returns undefined
    // for "--bucket" when args contains "--bucket=b" → USAGE_ERROR thrown before
    // the aws call even happens.
    const result = await s3Command(["head-object", "--bucket=b", "--key=k"], undefined, stub);

    // Verify the projected fields are present — proves the full round-trip ran.
    expect(result["contentType"]).toBe("application/json");
    expect(result["contentLength"]).toBe(2048);
  });

  it("head-object two-arg and equals-form return identical results", async () => {
    // Both invocations call the same stub binary with --bucket b --key k.
    // The difference is only in how the command adapter parses its own args.
    const stubA = createStub({ stdout: HEAD_OBJECT_RESPONSE, exitCode: 0 });
    const stubB = createStub({ stdout: HEAD_OBJECT_RESPONSE, exitCode: 0 });

    const resultA = await s3Command(
      ["head-object", "--bucket", "b", "--key", "k"],
      undefined,
      stubA,
    );
    const resultB = await s3Command(
      ["head-object", "--bucket=b", "--key=k"],
      undefined,
      stubB,
    );

    // Both projections must agree on every field.
    expect(resultA).toStrictEqual(resultB);
  });

  // ── create-bucket --bucket=b ────────────────────────────────────────────────
  it("create-bucket with --bucket=b and explicit --region=us-east-1 is not hard-rejected", async () => {
    // Stub returns success for create-bucket.
    const stub = createStub({
      stdout: JSON.stringify({ Location: "/equals-form-bucket" }),
      exitCode: 0,
    });

    // RED if extractFlag is not used: old parseFlag returns undefined for --bucket →
    // USAGE_ERROR thrown. With extractFlag, "equals-form-bucket" is correctly extracted.
    const result = await s3Command(
      ["create-bucket", "--bucket=equals-form-bucket", "--region=us-east-1"],
      undefined,
      stub,
    );

    expect(result["created"]).toBe(true);
    expect(result["bucket"]).toBe("equals-form-bucket");
  });

  // ── ls --starting-token=TOK ─────────────────────────────────────────────────
  it("ls --starting-token=TOK forwards the token to the aws call (equals form)", async () => {
    // Stub exits non-zero if --starting-token is NOT present in the argv it receives.
    // This proves the token is correctly extracted from the equals form and forwarded.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-cmd-st-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    const bucketPayload = JSON.stringify({
      Buckets: [{ Name: "b", CreationDate: "2024-01-01T00:00:00+00:00" }],
    });
    writeFileSync(p, [
      "#!/bin/sh",
      `if echo "$@" | grep -q 'starting-token'; then`,
      `  printf '${bucketPayload}'`,
      "  exit 0",
      "fi",
      "printf 'token-not-forwarded' >&2",
      "exit 1",
    ].join("\n"));
    chmodSync(p, 0o755);

    // RED for old code: parseFlag(indexOf) doesn't find "--starting-token" in
    // ["--starting-token=TOK"] → startingToken is undefined → s3LsRun omits
    // --starting-token from the aws call → stub exits 1.
    const result = await s3Command(
      ["ls", "--starting-token=TOK"],
      undefined,
      p,
    );

    expect(result["buckets"]).toHaveLength(1);
  });

  // ── ls --bucket-name-prefix=foo ─────────────────────────────────────────────
  it("ls --bucket-name-prefix=foo translates to --prefix foo in the aws call (equals form)", async () => {
    // Stub exits non-zero if --prefix is NOT present — proves translation ran.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-cmd-bnp-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    const bucketPayload = JSON.stringify({
      Buckets: [{ Name: "foo-bucket", CreationDate: "2024-01-01T00:00:00+00:00" }],
    });
    writeFileSync(p, [
      "#!/bin/sh",
      // The aws call will contain: s3api list-buckets --max-items 20 --prefix foo
      `if echo "$@" | grep -q -- '--prefix'; then`,
      `  printf '${bucketPayload}'`,
      "  exit 0",
      "fi",
      "printf 'prefix-not-forwarded' >&2",
      "exit 1",
    ].join("\n"));
    chmodSync(p, 0o755);

    // RED for old code: parseFlag(indexOf) returns undefined for "--bucket-name-prefix"
    // → bucketNamePrefix is undefined → no --prefix injected → stub exits 1.
    const result = await s3Command(
      ["ls", "--bucket-name-prefix=foo"],
      undefined,
      p,
    );

    expect(result["buckets"]).toHaveLength(1);
  });

  // ── ls s3://b/ --starting-token=TOK (guard path: equals form) ──────────────
  // ── ls s3://b/ --bucket-name-prefix=foo ─────────────────────────────────────
  it("ls s3://b/ --bucket-name-prefix=foo raises curated USAGE_ERROR (equals form)", async () => {
    // --bucket-name-prefix is invalid on the object-listing (prefix) path.
    // OLD code: hasFlag(includes) returns false for "--bucket-name-prefix=foo"
    // → guard bypassed → opaque aws 252 dump instead of a curated message.
    // NEW code: hasFlag (overlay-args) catches the equals form → USAGE_ERROR.
    //
    // No stub binary needed — the guard fires before any aws call.
    let thrown: unknown;
    try {
      await s3Command(["ls", "s3://b/", "--bucket-name-prefix=foo"], undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AxiError);
    expect((thrown as AxiError).code).toBe("USAGE_ERROR");
  });
});

// ---------------------------------------------------------------------------
// s3Command — boolean flags respect =false (ADR-0002 superset, PR #55 round-3)
//
// Bug introduced in ca9a326: replacing the old s3-private hasFlag (includes-only)
// with the shared hasFlag (presence-only) made `--dryrun=false` match as true,
// silently inverting the boolean on the write path.
//
//   PRE-FIX (ca9a326): s3 cp f.txt s3://b/ --dryrun=false → no wire call, exit 0
//   POST-FIX:          s3 cp f.txt s3://b/ --dryrun=false → real copy, dryRun: false
//
// Real `aws` hard-errors on --dryrun=false ("argument --dryrun: ignored explicit
// argument 'false'").  aws-axi accepts it as a superset extension and honours
// =false as false (flagIsTrue semantics, ADR-0002).
//
// These tests are WIRE-LEVEL: the stub binary is a real subprocess that inspects
// its own argv and exits 1 if the invariant is violated.  They prove behaviour,
// not just internal field values.
// ---------------------------------------------------------------------------

describe("s3Command — --flag=false honours explicit false on write paths", () => {
  // ── cp --dryrun=false → real copy (--dryrun must NOT reach aws) ─────────────
  it("cp --dryrun=false does NOT pass --dryrun to aws (file is copied)", async () => {
    // Stub: fails with exit 1 if `--dryrun` appears anywhere in its argv.
    // Pre-fix (ca9a326): hasFlag("--dryrun=false") → true → --dryrun forwarded → stub exits 1.
    // Post-fix:          flagIsTrue("--dryrun=false") → false → --dryrun NOT forwarded → stub exits 0.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-dryrun-cp-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q -- '--dryrun'; then
  printf 'FAIL: --dryrun was forwarded, but --dryrun=false was given' >&2
  exit 1
fi
printf 'copy: f.txt to s3://b/f.txt\n'
exit 0
`,
    );
    chmodSync(p, 0o755);

    const result = await s3Command(
      ["cp", "f.txt", "s3://b/f.txt", "--dryrun=false"],
      undefined,
      p,
    );

    // The field must be false and the copy must have proceeded (stub exited 0).
    expect(result["dryRun"]).toBe(false);
    expect(result["source"]).toBe("f.txt");
    expect(result["destination"]).toBe("s3://b/f.txt");
  });

  it("cp --dryrun (bare) still forwards --dryrun to aws (existing behaviour unchanged)", async () => {
    // Regression guard: bare --dryrun must still set dryRun=true.
    // Stub: fails if --dryrun is NOT in argv (proves it was forwarded).
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-dryrun-bare-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q -- '--dryrun'; then
  printf '(dryrun) copy: f.txt to s3://b/f.txt\n'
  exit 0
fi
printf 'FAIL: --dryrun was NOT forwarded' >&2
exit 1
`,
    );
    chmodSync(p, 0o755);

    const result = await s3Command(["cp", "f.txt", "s3://b/f.txt", "--dryrun"], undefined, p);
    expect(result["dryRun"]).toBe(true);
  });

  // ── rm --dryrun=false → real delete (--dryrun must NOT reach aws) ───────────
  it("rm --dryrun=false does NOT pass --dryrun to aws (object is deleted)", async () => {
    // Pre-fix: hasFlag → true → --dryrun forwarded → stub exits 1 (FAIL).
    // Post-fix: flagIsTrue → false → --dryrun NOT forwarded → stub exits 0.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-dryrun-rm-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q -- '--dryrun'; then
  printf 'FAIL: --dryrun was forwarded, but --dryrun=false was given' >&2
  exit 1
fi
printf 'delete: s3://b/old.txt\n'
exit 0
`,
    );
    chmodSync(p, 0o755);

    const result = await s3Command(["rm", "s3://b/old.txt", "--dryrun=false"], undefined, p);
    expect(result["dryRun"]).toBe(false);
    expect(result["target"]).toBe("s3://b/old.txt");
  });

  // ── ls s3://b/ --recursive=false → delimiter applied (NOT recursive) ─────────
  it("ls s3://b/ --recursive=false passes --delimiter / to aws (non-recursive listing)", async () => {
    // s3LsRun with recursive=false adds --delimiter / to the aws call.
    // Pre-fix: hasFlag("--recursive=false") → true → recursive=true → --delimiter OMITTED → recurses.
    // Post-fix: flagIsTrue("--recursive=false") → false → recursive=false → --delimiter / present.
    //
    // Stub: fails if --delimiter is absent from its argv.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-recursive-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    // Use an ETag without embedded double-quotes so printf does not swallow
    // the backslash escapes that JSON.stringify would otherwise introduce.
    const objResponse = JSON.stringify({
      Contents: [{ Key: "a.txt", Size: 1, LastModified: "2024-01-01T00:00:00+00:00", ETag: "abc123", StorageClass: "STANDARD" }],
      KeyCount: 1,
      MaxKeys: 20,
      IsTruncated: false,
      Name: "b",
      Prefix: "",
    });
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q -- '--delimiter'; then
  printf '${objResponse}'
  exit 0
fi
printf 'FAIL: --delimiter was NOT passed; listing recurses (expected non-recursive)' >&2
exit 1
`,
    );
    chmodSync(p, 0o755);

    const result = await s3Command(["ls", "s3://b/", "--recursive=false"], undefined, p);
    // Listing succeeded with --delimiter present; objects projected correctly.
    expect(result["objects"]).toBeDefined();
  });

  it("ls s3://b/ --recursive (bare) omits --delimiter / from aws (recursive listing)", async () => {
    // Regression guard: bare --recursive must still set recursive=true → no --delimiter.
    // Stub: fails if --delimiter IS in argv.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-s3-recursive-bare-"));
    tempDirs.push(dir);
    const p = join(dir, "aws");
    // Use an ETag without embedded double-quotes (same reason as above).
    const objResponse = JSON.stringify({
      Contents: [{ Key: "a/b.txt", Size: 2, LastModified: "2024-01-01T00:00:00+00:00", ETag: "def456", StorageClass: "STANDARD" }],
      KeyCount: 1,
      MaxKeys: 20,
      IsTruncated: false,
      Name: "b",
      Prefix: "",
    });
    writeFileSync(
      p,
      `#!/bin/sh
if echo "$@" | grep -q -- '--delimiter'; then
  printf 'FAIL: --delimiter was passed; expected recursive (no delimiter)' >&2
  exit 1
fi
printf '${objResponse}'
exit 0
`,
    );
    chmodSync(p, 0o755);

    const result = await s3Command(["ls", "s3://b/", "--recursive"], undefined, p);
    expect(result["objects"]).toBeDefined();
  });
});
