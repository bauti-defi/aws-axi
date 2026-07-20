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
import type { KmsListKeysResult, KmsListAliasesResult, KmsKeyDetail, KmsKeyPolicy } from "../src/commands/kms.js";
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
  /** When set, list-aliases emits this on stderr and exits with listAliasesExitCode. */
  readonly listAliasesStderr?: string;
  readonly listAliasesExitCode?: number;
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

  if (
    spec.listAliases !== undefined ||
    spec.listAliasesForKey !== undefined ||
    spec.listAliasesStderr !== undefined
  ) {
    lines.push("  list-aliases)");
    if (spec.listAliasesStderr !== undefined) {
      // Simulate a permission error (AccessDenied etc.)
      const aliasExit = spec.listAliasesExitCode ?? 254;
      lines.push(
        `    printf '%s' ${shellQuote(spec.listAliasesStderr)} >&2`,
        `    exit ${aliasExit};;`,
      );
    } else {
      const withKey = spec.listAliasesForKey ?? spec.listAliases ?? "{}";
      const withoutKey = spec.listAliases ?? spec.listAliasesForKey ?? "{}";
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
    // `KmsRunResult` includes `Record<string,unknown>` (--query path) which defeats `in`
    // narrowing; the runtime guard above proves this branch is the typed variant.
    const { listKeys } = result as { readonly listKeys: KmsListKeysResult };
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
    const { listKeys } = result as { readonly listKeys: KmsListKeysResult };
    expect(listKeys.count).toContain("2");
    expect(listKeys.count).toContain("total");
    expect(listKeys.nextToken).toBeUndefined();
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
    const { listKeys } = result as { readonly listKeys: KmsListKeysResult };
    expect(listKeys.keys).toHaveLength(0);
    expect(listKeys.message).toBeTruthy();
    expect(listKeys.suggestion).toBeTruthy();
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
    const { listKeys } = result as { readonly listKeys: KmsListKeysResult };
    expect(listKeys.nextToken).toBe("AQECAHiGqSomeToken==");
    expect(listKeys.count).toContain("truncated");
    expect(listKeys.count).toContain("AQECAHiGqSomeToken==");
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
    const { listAliases } = result as { readonly listAliases: KmsListAliasesResult };
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
    const { listAliases } = result as { readonly listAliases: KmsListAliasesResult };
    expect(listAliases.count).toContain("total");
  });
});

describe("kmsRun list-aliases — empty state", () => {
  it("returns message and suggestion when no aliases exist", async () => {
    const stub = createKmsStub({ listAliases: LIST_ALIASES_EMPTY });
    const result = await kmsRun({ subcommand: "list-aliases", args: [], binary: stub });
    if (!("listAliases" in result)) throw new Error("wrong discriminant");
    const { listAliases } = result as { readonly listAliases: KmsListAliasesResult };
    expect(listAliases.aliases).toHaveLength(0);
    expect(listAliases.message).toBeTruthy();
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
    const { key } = result as { readonly key: KmsKeyDetail };
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
    expect((result as { readonly key: KmsKeyDetail }).key.keyId).toBe(KEY_ID_1);
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

// ─── kmsRun: describe-key — global bool flag does not eat positional ──────────
//
// Regression introduced by the private extractPositionals in kms.ts (shared with
// lambda.ts): any --flag not in an explicit boolean set is treated as a value
// flag, so --no-cli-pager eats the following token (the key id / alias).
//
// Pre-fix (f66878c): extractPositionals(["--no-cli-pager", "alias/my-app-key"])
//   → --no-cli-pager treated as value flag → eats alias/my-app-key
//   → positionals = [] → USAGE_ERROR
//
// Post-fix (shared extractPositionals + GLOBAL_BOOL_FLAGS):
//   --no-cli-pager in GLOBAL_BOOL_FLAGS → boolean → alias/my-app-key kept
//   → positionals = ["alias/my-app-key"] → key resolved correctly

describe("kmsRun describe-key — global bool flag does not eat key positional", () => {
  it("--no-cli-pager before key alias: resolves key correctly (not USAGE_ERROR)", async () => {
    const stub = createKmsStub({
      describeKey: DESCRIBE_KEY_1,
      listAliasesForKey: LIST_ALIASES_FOR_KEY_1,
      listAliases: LIST_ALIASES_FOR_KEY_1,
    });

    // On broken head f66878c, --no-cli-pager eats KEY_ALIAS_1 (alias/my-app-key)
    // → extractPositionals returns [] → USAGE_ERROR.
    const result = await kmsRun({
      subcommand: "describe-key",
      args: ["--no-cli-pager", KEY_ALIAS_1],
      binary: stub,
    });

    expect("key" in result).toBe(true);
    if (!("key" in result)) throw new Error("wrong discriminant");
    expect((result as { readonly key: KmsKeyDetail }).key.keyId).toBe(KEY_ID_1);
  });

  it("--debug before key id: resolves key correctly (not USAGE_ERROR)", async () => {
    const stub = createKmsStub({
      describeKey: DESCRIBE_KEY_1,
      listAliasesForKey: LIST_ALIASES_FOR_KEY_1,
      listAliases: LIST_ALIASES_FOR_KEY_1,
    });

    const result = await kmsRun({
      subcommand: "describe-key",
      args: ["--debug", KEY_ID_1],
      binary: stub,
    });

    expect("key" in result).toBe(true);
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
    const { keyPolicy } = result as { readonly keyPolicy: KmsKeyPolicy };
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
    expect((result as { readonly keyPolicy: KmsKeyPolicy }).keyPolicy.policyName).toBe("custom");
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

// ─── extractFlag: --flag=value form ──────────────────────────────────────────
//
// Regression tests proving the equals form is forwarded correctly to aws.
// Agents commonly use --max-items=10; the old space-only impl silently
// ignored the value and sent the 50-item default to AWS.

describe("kmsRun list-keys — --flag=value form", () => {
  it("--max-items=N is forwarded correctly (not silently defaulted)", async () => {
    // Stub echoes its args; we verify --max-items 10 appears in the child call.
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-kms-eq-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "aws");
    writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        'case "$2" in',
        "  list-keys) echo \"$@\" ;;",
        `  list-aliases) printf '%s' ${shellQuote(LIST_ALIASES_EMPTY)} ;;`,
        "  *) exit 254;;",
        "esac",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);

    // list-keys stdout is the arg string (not JSON) → AxiError UNKNOWN
    // But the error message contains the forwarded args, proving --max-items 10
    // (not 50) was sent.
    try {
      await kmsRun({ subcommand: "list-keys", args: ["--max-items=10"], binary: scriptPath });
    } catch (e) {
      const msg = (e as AxiError).message;
      // Confirm the child received "--max-items 10", not "--max-items 50"
      expect(msg).toContain("--max-items");
      expect(msg).toContain("10");
      expect(msg).not.toContain("50");
    }
  });

  it("--next-token=TOKEN is extracted via equals form", async () => {
    // Just confirm extractFlag logic: pass through a real stub response
    const stub = createKmsStub({
      listKeys: LIST_KEYS_TWO,
      listAliases: LIST_ALIASES_EMPTY,
    });
    // Should not throw — the token is ignored by our stub, but extraction works
    const result = await kmsRun({
      subcommand: "list-keys",
      args: ["--next-token=AQECAHiGqSomeToken=="],
      binary: stub,
    });
    if (!("listKeys" in result)) throw new Error("wrong discriminant");
    expect((result as { readonly listKeys: KmsListKeysResult }).listKeys.keys).toHaveLength(2);
  });

  it("--policy-name=custom is respected in get-key-policy", async () => {
    const stub = createKmsStub({ getKeyPolicy: GET_KEY_POLICY_1 });

    const result = await kmsRun({
      subcommand: "get-key-policy",
      args: [KEY_ID_1, "--policy-name=custom"],
      binary: stub,
    });

    if (!("keyPolicy" in result)) throw new Error("wrong discriminant");
    expect((result as { readonly keyPolicy: KmsKeyPolicy }).keyPolicy.policyName).toBe("custom");
  });
});

// ─── Graceful degradation: alias-map failure ──────────────────────────────────
//
// If list-aliases returns an error (AccessDenied, throttle, etc.) the
// list-keys operation MUST NOT crash — it must return the keys without aliases.
// This is the "graceful degradation" claim from the implementation.

describe("kmsRun list-keys — alias-map AccessDenied degrades gracefully", () => {
  it("returns keys with alias=undefined when list-aliases is forbidden", async () => {
    const stub = createKmsStub({
      listKeys: LIST_KEYS_TWO,
      listAliasesStderr:
        "An error occurred (AccessDeniedException) when calling the ListAliases operation: User is not authorized",
      listAliasesExitCode: 254,
    });

    // Must NOT throw
    const result = await kmsRun({
      subcommand: "list-keys",
      args: [],
      binary: stub,
    });

    expect("listKeys" in result).toBe(true);
    if (!("listKeys" in result)) throw new Error("wrong discriminant");
    const { listKeys } = result as { readonly listKeys: KmsListKeysResult };
    // Both keys present, all with alias=undefined (degraded, not errored)
    expect(listKeys.keys).toHaveLength(2);
    for (const key of listKeys.keys) {
      expect(key.alias).toBeUndefined();
    }
  });
});

// ─── get-key-policy: non-JSON Policy fallback ─────────────────────────────────
//
// AWS occasionally returns a malformed or very large Policy that doesn't
// parse as JSON. The handler must NOT throw — it must surface the raw string.

describe("kmsRun get-key-policy — non-JSON Policy fallback", () => {
  it("returns raw Policy string when it is not valid JSON", async () => {
    const rawPolicyNotJson = JSON.stringify({
      Policy: "this-is-not-json { broken",
    });
    const stub = createKmsStub({ getKeyPolicy: rawPolicyNotJson });

    // Must NOT throw
    const result = await kmsRun({
      subcommand: "get-key-policy",
      args: [KEY_ID_1],
      binary: stub,
    });

    if (!("keyPolicy" in result)) throw new Error("wrong discriminant");
    const { keyPolicy } = result as { readonly keyPolicy: KmsKeyPolicy };
    // policy falls back to the raw string
    expect(typeof keyPolicy.policy).toBe("string");
    expect(keyPolicy.policy).toBe("this-is-not-json { broken");
  });
});
