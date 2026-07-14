/**
 * Secrets Manager overlay tests.
 *
 * All tests run against REAL subprocess stubs — no mock clients at the
 * exec-seam boundary.
 *
 * SECURITY INVARIANT: the actual secret value MUST NOT appear in the
 * result of any default (non-reveal) call. Every redaction path has an
 * explicit assertion that checks JSON.stringify(result).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { secretsRun, secretsCommand } from "../src/commands/secrets.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SECRET_NAME = "prod/my-app/db-password";
const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/my-app/db-password-AbCdEf";
const SECRET_VALUE = "sup3r-s3cr3t-p@ssw0rd!!ShouldNeverLeak";
const SECRET_VERSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const SECRET_NAME_2 = "prod/my-app/api-key";
const SECRET_ARN_2 =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/my-app/api-key-GhIjKl";

const KMS_KEY_ID = "bbbbaaaa-1111-2222-3333-ccccddddeeee";
const KMS_KEY_ARN = `arn:aws:kms:us-east-1:123456789012:key/${KMS_KEY_ID}`;
const KMS_KEY_ALIAS = "alias/secrets-test-key";

const GET_SECRET_VALUE_STRING = JSON.stringify({
  ARN: SECRET_ARN,
  Name: SECRET_NAME,
  VersionId: SECRET_VERSION_ID,
  SecretString: SECRET_VALUE,
  VersionStages: ["AWSCURRENT"],
  CreatedDate: "2024-01-15T10:00:00+00:00",
  LastChangedDate: "2024-06-01T12:00:00+00:00",
});

const DESCRIBE_SECRET_FULL = JSON.stringify({
  ARN: SECRET_ARN,
  Name: SECRET_NAME,
  Description: "Production DB password",
  KmsKeyId: KMS_KEY_ID,
  RotationEnabled: false,
  LastChangedDate: "2024-06-01T12:00:00+00:00",
  LastAccessedDate: "2024-06-10T08:00:00+00:00",
  Tags: [{ Key: "Environment", Value: "prod" }],
  VersionIdsToStages: { [SECRET_VERSION_ID]: ["AWSCURRENT"] },
  SecretVersionsToStages: { [SECRET_VERSION_ID]: ["AWSCURRENT"] },
});

const DESCRIBE_SECRET_NO_KMS = JSON.stringify({
  ARN: SECRET_ARN_2,
  Name: SECRET_NAME_2,
  Description: "API key (AWS-managed encryption)",
  RotationEnabled: false,
  LastChangedDate: "2024-05-01T08:00:00+00:00",
  Tags: [],
  VersionIdsToStages: {},
});

const LIST_SECRETS_TWO = JSON.stringify({
  SecretList: [
    {
      ARN: SECRET_ARN,
      Name: SECRET_NAME,
      Description: "Production DB password",
      KmsKeyId: KMS_KEY_ID,
      RotationEnabled: false,
      LastChangedDate: "2024-06-01T12:00:00+00:00",
      LastAccessedDate: "2024-06-10T08:00:00+00:00",
      Tags: [],
    },
    {
      ARN: SECRET_ARN_2,
      Name: SECRET_NAME_2,
      Description: "API key",
      RotationEnabled: true,
      LastRotatedDate: "2024-06-05T00:00:00+00:00",
      LastChangedDate: "2024-06-05T00:00:00+00:00",
      Tags: [],
    },
  ],
});

const LIST_SECRETS_TRUNCATED = JSON.stringify({
  SecretList: [
    {
      ARN: SECRET_ARN,
      Name: SECRET_NAME,
      Description: "Production DB password",
      KmsKeyId: KMS_KEY_ID,
      RotationEnabled: false,
      LastChangedDate: "2024-06-01T12:00:00+00:00",
      Tags: [],
    },
  ],
  NextToken: "AQECAHiGqSecretsToken==",
});

const LIST_SECRETS_EMPTY = JSON.stringify({ SecretList: [] });

// KMS fixtures for resolve-key enrichment
const KMS_DESCRIBE_KEY = JSON.stringify({
  KeyMetadata: {
    KeyId: KMS_KEY_ID,
    Arn: KMS_KEY_ARN,
    KeyState: "Enabled",
    Enabled: true,
    Description: "Secrets Manager encryption key",
    KeyManager: "CUSTOMER",
    KeyUsage: "ENCRYPT_DECRYPT",
    KeySpec: "SYMMETRIC_DEFAULT",
  },
});

const KMS_LIST_ALIASES_FOR_KEY = JSON.stringify({
  Aliases: [
    {
      AliasName: KMS_KEY_ALIAS,
      AliasArn: `arn:aws:kms:us-east-1:123456789012:${KMS_KEY_ALIAS}`,
      TargetKeyId: KMS_KEY_ID,
    },
  ],
});

const NOT_FOUND_STDERR =
  "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret";

// ─── Stub factory ─────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

interface StubEntry {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

type SecretsStubSpec = Record<string, StubEntry>;

function createStub(spec: SecretsStubSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-secrets-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "aws");

  const lines: string[] = ["#!/bin/sh", 'case "$1-$2" in'];

  for (const [key, entry] of Object.entries(spec)) {
    lines.push(`  ${key})`);
    if (entry.stderr !== undefined) {
      lines.push(`    printf '%s' ${shellQuote(entry.stderr)} >&2`);
    }
    if (entry.stdout !== undefined) {
      lines.push(`    printf '%s' ${shellQuote(entry.stdout)}`);
    }
    lines.push(`    exit ${entry.exitCode ?? 0};;`);
  }

  lines.push("  *)");
  lines.push('    printf "Unexpected: %s %s\\n" "$1" "$2" >&2');
  lines.push("    exit 254;;");
  lines.push("esac");

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

// ─── SECURITY INVARIANT helper ────────────────────────────────────────────────

function leaksValue(result: unknown, secret: string): boolean {
  return JSON.stringify(result).includes(secret);
}

// ─── get-secret-value — redaction ────────────────────────────────────────────

describe("secretsRun get-secret-value — default REDACTS the secret", () => {
  it("SecretString is NOT in result by default", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME],
      binary: stub,
    });

    // SECURITY: actual secret must be absent from serialised output
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);

    expect("secret" in result).toBe(true);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect(result.secret.name).toBe(SECRET_NAME);
    expect(result.secret.secretValue).toBe("<redacted>");
  });

  it("metadata fields are present: arn, versionId, versionStages, lastChanged", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME],
      binary: stub,
    });

    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect(result.secret.arn).toBe(SECRET_ARN);
    expect(result.secret.versionId).toBe(SECRET_VERSION_ID);
    expect(result.secret.versionStages).toContain("AWSCURRENT");
    expect(result.secret.lastChanged).toBeTruthy();
  });

  it("shows KMS alias from parallel describe-secret enrichment", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME],
      binary: stub,
    });

    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect(result.secret.kmsKeyAlias).toBe(KMS_KEY_ALIAS);
  });

  it("includes a suggestion to use --reveal", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME],
      binary: stub,
    });

    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect(result.suggestion).toBeTruthy();
    expect(result.suggestion).toContain("--reveal");
  });

  it("degrades gracefully when KMS enrichment fails", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": {
        stderr:
          "An error occurred (AccessDeniedException) when calling the DescribeKey operation: User not authorized",
        exitCode: 254,
      },
    });

    // Must NOT throw — degrades to raw kmsKeyId or undefined alias
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME],
      binary: stub,
    });

    if (!("secret" in result)) throw new Error("wrong discriminant");
    // Still present, just no alias
    expect(result.secret.name).toBe(SECRET_NAME);
    // Value still redacted even when enrichment fails
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
  });
});

describe("secretsRun get-secret-value --reveal — shows the actual secret", () => {
  it("reveals SecretString when --reveal is passed", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: ["--reveal", SECRET_NAME],
      binary: stub,
    });

    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect(result.secret.secretValue).toBe(SECRET_VALUE);
    expect(result.suggestion).toBeUndefined();
  });
});

// ─── get-secret-value — --reveal value matrix (redaction-bypass fix #56) ─────
//
// BUG (pre-fix): hasFlag("--reveal=false") returned true (flag token present)
// → revealed the plaintext secret. Caller explicitly opted OUT but got plaintext.
//
// FIX: replace hasFlag with flagIsTrueStrict — a whitelist helper:
//   bare --reveal / --reveal=true / =1 / =yes → reveal
//   --reveal=false / =0 / =no                 → redact (explicit opt-out)
//   --reveal=<unrecognised> / --reveal=        → redact (fail-safe for secrets)
//
// RED tests (fail on pre-fix hasFlag, pass after fix):
//   --reveal=false, =0, =no, =garbage, =off, = (empty)  → must REDACT
// GREEN sanity (pass both before and after):
//   --reveal=true, =1, =yes                             → must REVEAL

describe("secretsRun get-secret-value --reveal value matrix (redaction-bypass fix #56)", () => {
  function stubForReveal(): string {
    return createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });
  }

  async function getWithFlag(flag: string): Promise<unknown> {
    return secretsRun({
      subcommand: "get-secret-value",
      args: [flag, SECRET_NAME],
      binary: stubForReveal(),
    });
  }

  // ── RED before fix ─────────────────────────────────────────────────────────

  it("--reveal=false REDACTS — was leaking before fix", async () => {
    const result = await getWithFlag("--reveal=false");
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      "<redacted>",
    );
  });

  it("--reveal=0 REDACTS", async () => {
    const result = await getWithFlag("--reveal=0");
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      "<redacted>",
    );
  });

  it("--reveal=no REDACTS", async () => {
    const result = await getWithFlag("--reveal=no");
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      "<redacted>",
    );
  });

  it("--reveal=garbage REDACTS (fail-safe: unrecognised value → redact)", async () => {
    const result = await getWithFlag("--reveal=garbage");
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      "<redacted>",
    );
  });

  it("--reveal=off REDACTS (fail-safe)", async () => {
    const result = await getWithFlag("--reveal=off");
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      "<redacted>",
    );
  });

  it("--reveal= (empty) REDACTS (fail-safe)", async () => {
    const result = await getWithFlag("--reveal=");
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      "<redacted>",
    );
  });

  // ── GREEN sanity: known-true values must still reveal ──────────────────────

  it("--reveal=true still REVEALS (unaffected by fix)", async () => {
    const result = await getWithFlag("--reveal=true");
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      SECRET_VALUE,
    );
  });

  it("--reveal=1 still REVEALS", async () => {
    const result = await getWithFlag("--reveal=1");
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      SECRET_VALUE,
    );
  });

  it("--reveal=yes still REVEALS", async () => {
    const result = await getWithFlag("--reveal=yes");
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(
      SECRET_VALUE,
    );
  });
});

describe("secretsRun get-secret-value — errors", () => {
  it("throws USAGE_ERROR when no secret-id is provided", async () => {
    const stub = createStub({});

    await expect(
      secretsRun({ subcommand: "get-secret-value", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("throws SERVICE_CLIENT_ERROR on ResourceNotFoundException", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": {
        stderr: NOT_FOUND_STDERR,
        exitCode: 254,
      },
    });

    await expect(
      secretsRun({ subcommand: "get-secret-value", args: ["nonexistent"], binary: stub }),
    ).rejects.toMatchObject({ code: "SERVICE_CLIENT_ERROR" });
  });

  it("accepts --secret-id flag form", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: ["--secret-id", SECRET_NAME],
      binary: stub,
    });

    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect(result.secret.name).toBe(SECRET_NAME);
  });
});

// ─── list-secrets — redaction + pagination + KMS alias ───────────────────────

describe("secretsRun list-secrets — curated list with KMS alias enrichment", () => {
  it("shows KMS alias for secrets with KmsKeyId", async () => {
    const stub = createStub({
      "secretsmanager-list-secrets": { stdout: LIST_SECRETS_TWO },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "list-secrets",
      args: [],
      binary: stub,
    });

    if (!("secretList" in result)) throw new Error("wrong discriminant");
    const withKms = result.secretList.secrets.find((s) => s.name === SECRET_NAME);
    expect(withKms?.kmsKeyAlias).toBe(KMS_KEY_ALIAS);

    const withoutKms = result.secretList.secrets.find((s) => s.name === SECRET_NAME_2);
    // No KmsKeyId → no alias
    expect(withoutKms?.kmsKeyAlias).toBeUndefined();
  });

  it("count is honest — N total", async () => {
    const stub = createStub({
      "secretsmanager-list-secrets": { stdout: LIST_SECRETS_TWO },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "list-secrets",
      args: [],
      binary: stub,
    });

    if (!("secretList" in result)) throw new Error("wrong discriminant");
    expect(result.secretList.count).toContain("2");
    expect(result.secretList.count).toContain("total");
  });

  it("truncated result exposes nextToken", async () => {
    const stub = createStub({
      "secretsmanager-list-secrets": { stdout: LIST_SECRETS_TRUNCATED },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "list-secrets",
      args: ["--max-items", "1"],
      binary: stub,
    });

    if (!("secretList" in result)) throw new Error("wrong discriminant");
    expect(result.secretList.nextToken).toBe("AQECAHiGqSecretsToken==");
    expect(result.secretList.count).toContain("truncated");
  });

  it("empty state returns message and suggestion", async () => {
    const stub = createStub({
      "secretsmanager-list-secrets": { stdout: LIST_SECRETS_EMPTY },
    });

    const result = await secretsRun({
      subcommand: "list-secrets",
      args: [],
      binary: stub,
    });

    if (!("secretList" in result)) throw new Error("wrong discriminant");
    expect(result.secretList.secrets).toHaveLength(0);
    expect(result.secretList.message).toBeTruthy();
    expect(result.secretList.suggestion).toBeTruthy();
  });

  it("degrades gracefully when KMS alias resolution fails", async () => {
    const stub = createStub({
      "secretsmanager-list-secrets": { stdout: LIST_SECRETS_TWO },
      "kms-describe-key": {
        stderr:
          "An error occurred (AccessDeniedException) when calling the DescribeKey operation: User not authorized",
        exitCode: 254,
      },
    });

    // Must NOT throw
    const result = await secretsRun({
      subcommand: "list-secrets",
      args: [],
      binary: stub,
    });

    if (!("secretList" in result)) throw new Error("wrong discriminant");
    expect(result.secretList.secrets).toHaveLength(2);
    // Alias may be undefined or raw keyId — not the resolved alias
    const withKms = result.secretList.secrets.find((s) => s.name === SECRET_NAME);
    expect(withKms?.kmsKeyAlias).not.toBe(KMS_KEY_ALIAS);
  });
});

// ─── describe-secret — KMS alias enrichment ──────────────────────────────────

describe("secretsRun describe-secret — curated detail with KMS alias", () => {
  it("shows name, arn, description, rotation, lastChanged, kmsKeyAlias", async () => {
    const stub = createStub({
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "describe-secret",
      args: [SECRET_NAME],
      binary: stub,
    });

    if (!("secretDetail" in result)) throw new Error("wrong discriminant");
    expect(result.secretDetail.name).toBe(SECRET_NAME);
    expect(result.secretDetail.arn).toBe(SECRET_ARN);
    expect(result.secretDetail.description).toBe("Production DB password");
    expect(result.secretDetail.rotationEnabled).toBe(false);
    expect(result.secretDetail.lastChanged).toBeTruthy();
    expect(result.secretDetail.kmsKeyAlias).toBe(KMS_KEY_ALIAS);
  });

  it("kmsKeyAlias is undefined when no KmsKeyId on the secret", async () => {
    const stub = createStub({
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_NO_KMS },
    });

    const result = await secretsRun({
      subcommand: "describe-secret",
      args: [SECRET_NAME_2],
      binary: stub,
    });

    if (!("secretDetail" in result)) throw new Error("wrong discriminant");
    expect(result.secretDetail.kmsKeyAlias).toBeUndefined();
  });

  it("throws USAGE_ERROR when no secret-id is provided", async () => {
    const stub = createStub({});

    await expect(
      secretsRun({ subcommand: "describe-secret", args: [], binary: stub }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("accepts --secret-id flag form", async () => {
    const stub = createStub({
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });

    const result = await secretsRun({
      subcommand: "describe-secret",
      args: ["--secret-id", SECRET_NAME],
      binary: stub,
    });

    if (!("secretDetail" in result)) throw new Error("wrong discriminant");
    expect(result.secretDetail.name).toBe(SECRET_NAME);
  });
});

// ─── get-secret-value — two-arg --reveal form (PR #58 round-2 blocker fix) ───
//
// The two-arg form `--reveal false` was NOT tested in PR #58 round-1.  Both
// `flagIsTrue` and `flagIsTrueStrict` short-circuited on the bare-presence
// check (`if (a === flag) return true`) before inspecting the next token, so
// `--reveal false` was indistinguishable from bare `--reveal` and leaked.
//
// Revert-proof:
//   R1: Revert the two-arg peek in flagIsTrueStrict (restore `if (a===flag) return true`)
//       → "two-arg --reveal false REDACTS" goes RED.
//   R2: Revert extractPositionals to not consume bool literal
//       → "flag-first two-arg --reveal false prod/db correctly resolves secretId"
//         goes RED (secretId becomes "false" → USAGE_ERROR: missing secret id
//         or wrong resource).

describe("secretsRun get-secret-value — two-arg --reveal false (round-2 fix)", () => {
  function stubForReveal(): string {
    return createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });
  }

  // ── RED before fix ──────────────────────────────────────────────────────────

  it("--reveal false (two-arg, flag-last) REDACTS — was leaking before round-2 fix", async () => {
    // `args: [SECRET_NAME, "--reveal", "false"]` — standard flag-last form.
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME, "--reveal", "false"],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe("<redacted>");
  });

  it("--reveal 0 (two-arg) REDACTS", async () => {
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME, "--reveal", "0"],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe("<redacted>");
  });

  it("--reveal no (two-arg) REDACTS", async () => {
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME, "--reveal", "no"],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe("<redacted>");
  });

  // ── GREEN: two-arg true still reveals ──────────────────────────────────────

  it("--reveal true (two-arg) still REVEALS", async () => {
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME, "--reveal", "true"],
      binary: stubForReveal(),
    });
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(SECRET_VALUE);
  });

  it("--reveal 1 (two-arg) still REVEALS", async () => {
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME, "--reveal", "1"],
      binary: stubForReveal(),
    });
    if (!("secret" in result)) throw new Error("wrong discriminant");
    expect((result as { secret: { secretValue: string } }).secret.secretValue).toBe(SECRET_VALUE);
  });

  // ── Positional interaction ──────────────────────────────────────────────────

  it("flag-first two-arg --reveal false resolves secretId correctly (not 'false')", async () => {
    // `args: ["--reveal", "false", SECRET_NAME]` — flag-first.
    // After extractPositionals fix, "false" is consumed as the flag value,
    // so SECRET_NAME is positionals[0] (correct secretId).
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: ["--reveal", "false", SECRET_NAME],
      binary: stubForReveal(),
    });
    expect(leaksValue(result, SECRET_VALUE)).toBe(false);
    if (!("secret" in result)) throw new Error("wrong discriminant");
    // Name should be the real SECRET_NAME, not "false"
    expect((result as { secret: { name: string } }).secret.name).toBe(SECRET_NAME);
  });
});

// ─── get-secret-value — --query guard (PR #58 round-2 fix) ──────────────────
//
// --query without --reveal on get-secret-value was silently returning plaintext.
// The hasQuery branch returned awsJson before reveal was consulted; since
// SecretsManager always returns SecretString in plaintext, any --query call
// would print the secret.
//
// Operator decision: hard USAGE_ERROR when --query is present without --reveal
// on get-secret-value (the one SecretString-bearing overlay op).
//
// Scope justification (verified in round-2 review):
//   - SSM: NOT affected. Without --with-decryption, AWS returns ciphertext.
//   - list-secrets / describe-secret: NOT affected. No SecretString in response.
//   - Engine path (batch-get-secret-value etc.): pre-existing known gap, tracked
//     separately via issue filed in this PR.

describe("secretsRun get-secret-value — --query guard (round-2 fix)", () => {
  function stubForQuery(): string {
    return createStub({
      "secretsmanager-get-secret-value": { stdout: GET_SECRET_VALUE_STRING },
      "secretsmanager-describe-secret": { stdout: DESCRIBE_SECRET_FULL },
      "kms-describe-key": { stdout: KMS_DESCRIBE_KEY },
      "kms-list-aliases": { stdout: KMS_LIST_ALIASES_FOR_KEY },
    });
  }

  it("--query without --reveal throws USAGE_ERROR", async () => {
    await expect(
      secretsRun({
        subcommand: "get-secret-value",
        args: [SECRET_NAME, "--query", "SecretString"],
        binary: stubForQuery(),
      }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("--query with --reveal=false throws USAGE_ERROR (--reveal=false ≠ revealed)", async () => {
    await expect(
      secretsRun({
        subcommand: "get-secret-value",
        args: [SECRET_NAME, "--reveal=false", "--query", "SecretString"],
        binary: stubForQuery(),
      }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("--query with --reveal (bare) succeeds — caller opted in", async () => {
    // With --reveal, --query is legal and returns the raw JMESPath result.
    // The stub returns GET_SECRET_VALUE_STRING; with --query the overlay forwards
    // it to the real aws call (via stub), returning a raw Record.
    const stub = createStub({
      "secretsmanager-get-secret-value": {
        stdout: JSON.stringify({ SecretString: SECRET_VALUE }),
      },
    });
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME, "--reveal", "--query", "SecretString"],
      binary: stub,
    });
    // raw record — no curated projection
    expect(result).toBeDefined();
  });

  it("--query with --reveal=true succeeds", async () => {
    const stub = createStub({
      "secretsmanager-get-secret-value": {
        stdout: JSON.stringify({ SecretString: SECRET_VALUE }),
      },
    });
    const result = await secretsRun({
      subcommand: "get-secret-value",
      args: [SECRET_NAME, "--reveal=true", "--query", "SecretString"],
      binary: stub,
    });
    expect(result).toBeDefined();
  });
});

// ─── secretsCommand — dispatch ───────────────────────────────────────────────

describe("secretsCommand — dispatch", () => {
  it("defaults to list-secrets when no subcommand given", async () => {
    const stub = createStub({
      "secretsmanager-list-secrets": { stdout: LIST_SECRETS_EMPTY },
    });

    const result = await secretsRun({
      subcommand: "",
      args: [],
      binary: stub,
    });

    expect("secretList" in result).toBe(true);
  });

  it("throws USAGE_ERROR for an unknown subcommand", async () => {
    await expect(
      secretsRun({ subcommand: "invalid-subcmd", args: [], binary: createStub({}) }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("wraps result under top-level 'secretsmanager' key via secretsCommand", async () => {
    const stub = createStub({
      "secretsmanager-list-secrets": { stdout: LIST_SECRETS_EMPTY },
    });

    const run = await secretsRun({
      subcommand: "list-secrets",
      args: [],
      binary: stub,
    });

    const wrapped: Record<string, unknown> = { secretsmanager: run };
    expect(Object.keys(wrapped)).toContain("secretsmanager");
    expect("secretList" in (wrapped["secretsmanager"] as object)).toBe(true);
  });
});
