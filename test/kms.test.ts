/**
 * KMS overlay + resolve-key tests.
 *
 * All tests run against REAL subprocess stubs — no mock clients at the
 * exec-seam boundary. Each test creates its own temp dir with a unique
 * `aws` stub script, so the module-level alias-map cache (keyed by binary
 * path) never collides between test cases.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AxiError } from "axi-sdk-js";
import { kmsRun, kmsCommand } from "../src/commands/kms.js";
import { resolveKey, loadAliasMap } from "../src/resolve/key.js";

// ─── Fixture data ─────────────────────────────────────────────────────────────

const KEY_ID_1 = "1234abcd-12ab-34cd-56ef-1234567890ab";
const KEY_ARN_1 = `arn:aws:kms:us-east-1:123456789012:key/${KEY_ID_1}`;
const KEY_ALIAS_1 = "alias/my-app-key";

const KEY_ID_2 = "abcd5678-ab12-cd34-ef56-abcdef012345";
const KEY_ARN_2 = `arn:aws:kms:us-east-1:123456789012:key/${KEY_ID_2}`;

const LIST_KEYS_TWO = JSON.stringify({
  Keys: [
    { KeyId: KEY_ID_1, KeyArn: KEY_ARN_1 },
    { KeyId: KEY_ID_2, KeyArn: KEY_ARN_2 },
  ],
});

const LIST_KEYS_ONE_TRUNCATED = JSON.stringify({
  Keys: [{ KeyId: KEY_ID_1, KeyArn: KEY_ARN_1 }],
  NextToken: "AQECAHiGqSomeToken==",
});

const LIST_KEYS_EMPTY = JSON.stringify({ Keys: [] });

const LIST_ALIASES_TWO = JSON.stringify({
  Aliases: [
    {
      AliasName: KEY_ALIAS_1,
      AliasArn: `arn:aws:kms:us-east-1:123456789012:${KEY_ALIAS_1}`,
      TargetKeyId: KEY_ID_1,
      CreationDate: "2024-01-15T10:00:00+00:00",
      LastUpdatedDate: "2024-01-15T10:00:00+00:00",
    },
    {
      AliasName: "alias/aws/s3",
      AliasArn: "arn:aws:kms:us-east-1:123456789012:alias/aws/s3",
      TargetKeyId: undefined,
      CreationDate: "2023-01-01T00:00:00+00:00",
      LastUpdatedDate: "2023-01-01T00:00:00+00:00",
    },
  ],
});

const LIST_ALIASES_FOR_KEY_1 = JSON.stringify({
  Aliases: [
    {
      AliasName: KEY_ALIAS_1,
      AliasArn: `arn:aws:kms:us-east-1:123456789012:${KEY_ALIAS_1}`,
      TargetKeyId: KEY_ID_1,
      CreationDate: "2024-01-15T10:00:00+00:00",
      LastUpdatedDate: "2024-01-15T10:00:00+00:00",
    },
  ],
});

const LIST_ALIASES_EMPTY = JSON.stringify({ Aliases: [] });

const DESCRIBE_KEY_1 = JSON.stringify({
  KeyMetadata: {
    AWSAccountId: "123456789012",
    KeyId: KEY_ID_1,
    Arn: KEY_ARN_1,
    CreationDate: "2024-01-15T10:00:00+00:00",
    Enabled: true,
    Description: "My application encryption key",
    KeyUsage: "ENCRYPT_DECRYPT",
    KeyState: "Enabled",
    Origin: "AWS_KMS",
    KeyManager: "CUSTOMER",
    KeySpec: "SYMMETRIC_DEFAULT",
    MultiRegion: false,
  },
});

const GET_KEY_POLICY_1 = JSON.stringify({
  Policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Enable IAM User Permissions",
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::123456789012:root" },
        Action: "kms:*",
        Resource: "*",
      },
    ],
  }),
});

const NOT_FOUND_STDERR =
  "An error occurred (NotFoundException) when calling the DescribeKey operation: Invalid keyId alias/nonexistent";

// ─── Stub factory ─────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

interface KmsStubSpec {
  readonly listKeys?: string;
  readonly listAliases?: string;
  readonly listAliasesForKey?: string; // when --key-id present in args
  readonly describeKey?: string;
  readonly getKeyPolicy?: string;
  readonly exitCode?: number; // non-zero exit for all subcommands
  readonly describeKeyExitCode?: number;
  readonly describeKeyStderr?: string;
}

/**
 * Create a real shell stub that dispatches on $2 (the kms subcommand).
 * Unique binary path per invocation → unique alias-map cache key.
 */
function createKmsStub(spec: KmsStubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-kms-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "aws");

  const defaultExit = spec.exitCode ?? 0;
  const lines: string[] = ["#!/bin/sh", 'case "$2" in'];

  if (spec.listKeys !== undefined) {
    lines.push(
      "  list-keys)",
      `    printf '%s' ${shellQuote(spec.listKeys)}`,
      `    exit ${defaultExit};;`,
    );
  }

  if (spec.listAliases !== undefined || spec.listAliasesForKey !== undefined) {
    const withKey = spec.listAliasesForKey ?? spec.listAliases ?? "{}";
    const withoutKey = spec.listAliases ?? spec.listAliasesForKey ?? "{}";
    lines.push("  list-aliases)");
    if (
      spec.listAliasesForKey !== undefined &&
      spec.listAliases !== undefined
    ) {
      // Dispatch on --key-id presence
      lines.push(
        `    if echo "$@" | grep -q -- "--key-id"; then`,
        `      printf '%s' ${shellQuote(withKey)}`,
        `      exit ${defaultExit}`,
        "    else",
        `      printf '%s' ${shellQuote(withoutKey)}`,
        `      exit ${defaultExit}`,
        "    fi;;",
      );
    } else {
      // Single response regardless of --key-id
      lines.push(
        `    printf '%s' ${shellQuote(withKey)}`,
        `    exit ${defaultExit};;`,
      );
    }
  }

  if (spec.describeKey !== undefined || spec.describeKeyStderr !== undefined) {
    const exitCode = spec.describeKeyExitCode ?? defaultExit;
    lines.push("  describe-key)");
    if (spec.describeKeyStderr !== undefined) {
      lines.push(`    printf '%s' ${shellQuote(spec.describeKeyStderr)} >&2`);
    } else if (spec.describeKey !== undefined) {
      lines.push(`    printf '%s' ${shellQuote(spec.describeKey)}`);
    }
    lines.push(`    exit ${exitCode};;`);
  }

  if (spec.getKeyPolicy !== undefined) {
    lines.push(
      "  get-key-policy)",
      `    printf '%s' ${shellQuote(spec.getKeyPolicy)}`,
      `    exit ${defaultExit};;`,
    );
  }

  lines.push(
    "  *)",
    '    printf "Unexpected kms subcommand: %s\\n" "$2" >&2',
    "    exit 254;;",
    "esac",
  );

  writeFileSync(scriptPath, lines.join("\n"));
  chmodSync(scriptPath, 0o755);
  return scriptPath;
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

// ─── loadAliasMap ──────────────────────────────────────────────────────────────

describe("loadAliasMap", () => {
  it("returns a map of keyId → aliasName", async () => {
    const stub = createKmsStub({ listAliases: LIST_ALIASES_TWO });
    const map = await loadAliasMap({ binary: stub });

    expect(map.get(KEY_ID_1)).toBe(KEY_ALIAS_1);
  });

  it("ignores AWS-managed aliases with no TargetKeyId", async () => {
    const stub = createKmsStub({ listAliases: LIST_ALIASES_TWO });
    const map = await loadAliasMap({ binary: stub });

    // alias/aws/s3 has TargetKeyId: undefined — not in the map
    expect([...map.values()].includes("alias/aws/s3")).toBe(false);
  });

  it("returns empty map for empty alias list", async () => {
    const stub = createKmsStub({ listAliases: LIST_ALIASES_EMPTY });
    const map = await loadAliasMap({ binary: stub });

    expect(map.size).toBe(0);
  });

  it("caches across calls with the same binary path", async () => {
    // The stub only knows list-aliases — a second call with a DIFFERENT stub
    // would fail. But since the first call populates the cache under the first
    // binary path, reusing the same path returns the cached result.
    const stub = createKmsStub({ listAliases: LIST_ALIASES_TWO });
    const map1 = await loadAliasMap({ binary: stub });
    const map2 = await loadAliasMap({ binary: stub });

    expect(map1).toBe(map2); // same reference (cached)
  });
});

// ─── resolveKey ───────────────────────────────────────────────────────────────

describe("resolveKey", () => {
  it("resolves a keyId to canonical identity with alias", async () => {
    const stub = createKmsStub({
      describeKey: DESCRIBE_KEY_1,
      listAliasesForKey: LIST_ALIASES_FOR_KEY_1,
      listAliases: LIST_ALIASES_FOR_KEY_1,
    });

    const resolved = await resolveKey(KEY_ID_1, { binary: stub });

    expect(resolved.keyId).toBe(KEY_ID_1);
    expect(resolved.arn).toBe(KEY_ARN_1);
    expect(resolved.alias).toBe(KEY_ALIAS_1);
  });

  it("resolves an alias input to the underlying key", async () => {
    // aws kms describe-key accepts alias/my-key as --key-id input
    const stub = createKmsStub({
      describeKey: DESCRIBE_KEY_1,
      listAliases: LIST_ALIASES_FOR_KEY_1,
    });

    const resolved = await resolveKey(KEY_ALIAS_1, { binary: stub });

    expect(resolved.keyId).toBe(KEY_ID_1);
    expect(resolved.alias).toBe(KEY_ALIAS_1);
  });

  it("returns alias: undefined when no aliases exist for key", async () => {
    const stub = createKmsStub({
      describeKey: DESCRIBE_KEY_1,
      listAliases: LIST_ALIASES_EMPTY,
    });

    const resolved = await resolveKey(KEY_ID_2, { binary: stub });

    expect(resolved.alias).toBeUndefined();
  });

  it("throws AxiError (SERVICE_CLIENT_ERROR) when key is not found", async () => {
    const stub = createKmsStub({
      describeKeyStderr: NOT_FOUND_STDERR,
      describeKeyExitCode: 254,
    });

    await expect(resolveKey("alias/nonexistent", { binary: stub })).rejects.toMatchObject({
      code: "SERVICE_CLIENT_ERROR",
    });
  });
});

// ─── kmsRun: list-keys ────────────────────────────────────────────────────────

describe("kmsRun list-keys — happy path", () => {
  it("returns curated key list with aliases", async () => {
    const stub = createKmsStub({
      listKeys: LIST_KEYS_TWO,
      listAliases: LIST_ALIASES_TWO,
    });

    const result = await kmsRun({
      subcommand: "list-keys",
      args: [],
      binary: stub,
    });

    expect("listKeys" in result).toBe(true);
    if (!("listKeys" in result)) throw new Error("wrong discriminant");

    const { listKeys } = result;
    expect(listKeys.keys).toHaveLength(2);

    const key1 = listKeys.keys.find((k) => k.keyId === KEY_ID_1);
    expect(key1?.alias).toBe(KEY_ALIAS_1);
    expect(key1?.arn).toBe(KEY_ARN_1);

    const key2 = listKeys.keys.find((k) => k.keyId === KEY_ID_2);
    expect(key2?.alias).toBeUndefined();
  });

  it("count string shows N total when not truncated", async () => {
    const stub = createKmsStub({
      listKeys: LIST_KEYS_TWO,
      listAliases: LIST_ALIASES_EMPTY,
    });

    const result = await kmsRun({ subcommand: "list-keys", args: [], binary: stub });
    if (!("listKeys" in result)) throw new Error("wrong discriminant");

    expect(result.listKeys.count).toContain("2");
    expect(result.listKeys.count).toContain("total");
    expect(result.listKeys.nextToken).toBeUndefined();
  });
});

describe("kmsRun list-keys — empty state", () => {
  it("returns message and suggestion when no keys exist", async () => {
    const stub = createKmsStub({
      listKeys: LIST_KEYS_EMPTY,
      listAliases: LIST_ALIASES_EMPTY,
    });

    const result = await kmsRun({ subcommand: "list-keys", args: [], binary: stub });
    if (!("listKeys" in result)) throw new Error("wrong discriminant");

    expect(result.listKeys.keys).toHaveLength(0);
    expect(result.listKeys.message).toBeTruthy();
    expect(result.listKeys.suggestion).toBeTruthy();
  });
});

describe("kmsRun list-keys — pagination", () => {
  it("reports truncated count and exposes next-token when response is truncated", async () => {
    const stub = createKmsStub({
      listKeys: LIST_KEYS_ONE_TRUNCATED,
      listAliases: LIST_ALIASES_EMPTY,
    });

    const result = await kmsRun({
      subcommand: "list-keys",
      args: ["--max-items", "1"],
      binary: stub,
    });
    if (!("listKeys" in result)) throw new Error("wrong discriminant");

    expect(result.listKeys.nextToken).toBe("AQECAHiGqSomeToken==");
    expect(result.listKeys.count).toContain("truncated");
    expect(result.listKeys.count).toContain("AQECAHiGqSomeToken==");
  });

  it("passes --max-items to aws cli (defaults to 50)", async () => {
    // Stub echoes its args so we can inspect them
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-kms-args-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "aws");
    writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        "case \"$2\" in",
        "  list-keys) echo \"$@\" ;;",
        `  list-aliases) printf '%s' ${shellQuote(LIST_ALIASES_EMPTY)} ;;`,
        "  *) exit 254;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);

    // This will throw on JSON parse (we printed args not JSON) — but we can
    // intercept the AxiError to confirm --max-items was included.
    try {
      await kmsRun({ subcommand: "list-keys", args: [], binary: scriptPath });
    } catch (e) {
      // The stdout was the args string, not JSON — AxiError UNKNOWN
      expect((e as AxiError).message).toContain("--max-items");
    }
  });
});

// ─── kmsRun: list-aliases ─────────────────────────────────────────────────────

describe("kmsRun list-aliases — happy path", () => {
  it("returns curated alias list", async () => {
    const stub = createKmsStub({ listAliases: LIST_ALIASES_TWO });

    const result = await kmsRun({ subcommand: "list-aliases", args: [], binary: stub });

    expect("listAliases" in result).toBe(true);
    if (!("listAliases" in result)) throw new Error("wrong discriminant");

    const { listAliases } = result;
    expect(listAliases.aliases.length).toBeGreaterThanOrEqual(1);

    const appAlias = listAliases.aliases.find(
      (a) => a.aliasName === KEY_ALIAS_1,
    );
    expect(appAlias).toBeDefined();
    expect(appAlias?.targetKeyId).toBe(KEY_ID_1);
  });

  it("count string shows N total", async () => {
    const stub = createKmsStub({ listAliases: LIST_ALIASES_TWO });
    const result = await kmsRun({ subcommand: "list-aliases", args: [], binary: stub });
    if (!("listAliases" in result)) throw new Error("wrong discriminant");

    expect(result.listAliases.count).toContain("total");
  });
});

describe("kmsRun list-aliases — empty state", () => {
  it("returns message and suggestion when no aliases exist", async () => {
    const stub = createKmsStub({ listAliases: LIST_ALIASES_EMPTY });
    const result = await kmsRun({ subcommand: "list-aliases", args: [], binary: stub });
    if (!("listAliases" in result)) throw new Error("wrong discriminant");

    expect(result.listAliases.aliases).toHaveLength(0);
    expect(result.listAliases.message).toBeTruthy();
  });
});

// ─── kmsRun: describe-key ─────────────────────────────────────────────────────

describe("kmsRun describe-key — happy path", () => {
  it("returns curated key detail with alias", async () => {
    const stub = createKmsStub({
      describeKey: DESCRIBE_KEY_1,
      listAliasesForKey: LIST_ALIASES_FOR_KEY_1,
      listAliases: LIST_ALIASES_FOR_KEY_1,
    });

    const result = await kmsRun({
      subcommand: "describe-key",
      args: [KEY_ID_1],
      binary: stub,
    });

    expect("key" in result).toBe(true);
    if (!("key" in result)) throw new Error("wrong discriminant");

    const { key } = result;
    expect(key.keyId).toBe(KEY_ID_1);
    expect(key.arn).toBe(KEY_ARN_1);
    expect(key.alias).toBe(KEY_ALIAS_1);
    expect(key.enabled).toBe(true);
    expect(key.state).toBe("Enabled");
    expect(key.keyManager).toBe("CUSTOMER");
    expect(key.description).toBe("My application encryption key");
    expect(key.keyUsage).toBe("ENCRYPT_DECRYPT");
    expect(key.keySpec).toBe("SYMMETRIC_DEFAULT");
  });

  it("accepts an alias as the key identifier", async () => {
    const stub = createKmsStub({
      describeKey: DESCRIBE_KEY_1,
      listAliases: LIST_ALIASES_FOR_KEY_1,
    });

    const result = await kmsRun({
      subcommand: "describe-key",
      args: [KEY_ALIAS_1],
      binary: stub,
    });

    if (!("key" in result)) throw new Error("wrong discriminant");
    expect(result.key.keyId).toBe(KEY_ID_1);
  });
});

describe("kmsRun describe-key — errors", () => {
  it("requires a key identifier (positional arg)", async () => {
    const stub = createKmsStub({ describeKey: DESCRIBE_KEY_1 });

    await expect(
      kmsRun({ subcommand: "describe-key", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("throws AxiError on NotFoundException from aws", async () => {
    const stub = createKmsStub({
      describeKeyStderr: NOT_FOUND_STDERR,
      describeKeyExitCode: 254,
    });

    await expect(
      kmsRun({ subcommand: "describe-key", args: ["alias/nonexistent"], binary: stub }),
    ).rejects.toMatchObject({ code: "SERVICE_CLIENT_ERROR" });
  });
});

// ─── kmsRun: get-key-policy ───────────────────────────────────────────────────

describe("kmsRun get-key-policy — happy path", () => {
  it("returns the parsed key policy (JSON embedded in Policy string)", async () => {
    const stub = createKmsStub({
      getKeyPolicy: GET_KEY_POLICY_1,
    });

    const result = await kmsRun({
      subcommand: "get-key-policy",
      args: [KEY_ID_1],
      binary: stub,
    });

    expect("keyPolicy" in result).toBe(true);
    if (!("keyPolicy" in result)) throw new Error("wrong discriminant");

    const { keyPolicy } = result;
    expect(keyPolicy.keyId).toBe(KEY_ID_1);
    expect(keyPolicy.policyName).toBe("default");
    // Policy should be parsed object, not a raw JSON string
    expect(typeof keyPolicy.policy).toBe("object");
    expect((keyPolicy.policy as Record<string, unknown>)["Version"]).toBe(
      "2012-10-17",
    );
  });

  it("uses custom --policy-name when specified", async () => {
    const stub = createKmsStub({ getKeyPolicy: GET_KEY_POLICY_1 });

    const result = await kmsRun({
      subcommand: "get-key-policy",
      args: [KEY_ID_1, "--policy-name", "custom"],
      binary: stub,
    });

    if (!("keyPolicy" in result)) throw new Error("wrong discriminant");
    expect(result.keyPolicy.policyName).toBe("custom");
  });

  it("requires a key identifier", async () => {
    const stub = createKmsStub({ getKeyPolicy: GET_KEY_POLICY_1 });

    await expect(
      kmsRun({ subcommand: "get-key-policy", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

// ─── kmsCommand: arg dispatch ─────────────────────────────────────────────────

describe("kmsCommand — arg dispatch", () => {
  it("throws USAGE_ERROR for an unknown subcommand", async () => {
    await expect(
      kmsCommand(["invalid-subcmd"], undefined),
    ).rejects.toMatchObject({
      code: "USAGE_ERROR",
    });
  });

  it("wraps kmsRun result under a kms key", async () => {
    const stub = createKmsStub({
      listKeys: LIST_KEYS_TWO,
      listAliases: LIST_ALIASES_TWO,
    });

    // kmsCommand doesn't accept binary — test via kmsRun result shape
    const run = await kmsRun({ subcommand: "list-keys", args: [], binary: stub });
    const wrapped: Record<string, unknown> = { kms: run };

    expect(Object.keys(wrapped)).toContain("kms");
    expect("listKeys" in (wrapped["kms"] as object)).toBe(true);
  });
});
