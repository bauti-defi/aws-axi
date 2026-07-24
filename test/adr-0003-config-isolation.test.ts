/**
 * Enforcement test for ADR-0003 — src/aws-config.ts has exactly one importer
 * in src/: src/aws.ts (the diagnostics-only error path).
 *
 * WHY THIS EXISTS:
 *
 * During PR #71 cycle 2 (commit 18acb3c), src/commands/whoami.ts imported
 * src/aws-config.ts to back the "region" field of `whoami` output. The
 * hand-rolled INI parser diverged from `aws configure get region` in six
 * independently measured ways — including reporting the wrong region when
 * ~/.aws/credentials overrides ~/.aws/config (the "credentials-file-wins"
 * precedence that botocore applies but the parser missed). That one import
 * cost a full review cycle to catch and cost the `18acb3c` commit its first
 * blocker.
 *
 * ADR-0003's invariant (enforced here):
 *   src/aws-config.ts may only be imported by src/aws.ts.
 *
 * Any other importer in src/ re-creates the 18acb3c mistake — backing a
 * reported value with a second parser rather than delegating to the aws CLI
 * that users actually trust. The diagnostic path (profile listing in error
 * messages) is the one accepted carve-out, and it lives behind src/aws.ts's
 * enrichNoCredsError helper — commands must go through that, never import
 * src/aws-config.ts directly.
 *
 * Cross-reference: docs/adr/0003-cli-delegation-for-reported-values.md
 *
 * RELATIONSHIP TO #72 STRUCTURAL FIX:
 *
 * After the #72 structural enrichment fix, awsRaw itself computes and returns
 * result.error (a parsed + enriched ParsedAwsError) for every non-zero exit.
 * Command and resolve modules simply read result.error — they no longer need
 * to import parseAwsError or parseAndEnrichAwsError at all.
 *
 * This guard is now a backstop: it catches the most common regression shapes
 * (static imports of parseAwsError / mapAwsError in commands / resolve dirs).
 * It is no longer the primary line of defence — the structural guarantee in
 * awsRaw is. See test/aws.test.ts ("Structural enrichment" suite) for the
 * behavioural proof.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(join(import.meta.dir, ".."));
const SRC_DIR = join(REPO_ROOT, "src");

/**
 * The one src/ file that is permitted to import src/aws-config.ts.
 * It wraps the parser behind enrichNoCredsError so command modules never
 * need to — and therefore never accidentally can — import it directly.
 */
const ALLOWED_IMPORTER = "src/aws.ts";

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Detect a relative import of aws-config (any extension or no extension)
 * in a TypeScript source file.
 */
function importsAwsConfig(content: string): boolean {
  return /from\s+["'][^"']*\/aws-config(?:\.(?:js|ts))?["']/.test(content);
}

describe("ADR-0003 invariant — src/aws-config.ts has exactly one importer in src/", () => {
  it("only src/aws.ts imports src/aws-config.ts", () => {
    const tsFiles = collectTsFiles(SRC_DIR);
    const importers: string[] = [];

    for (const file of tsFiles) {
      const content = readFileSync(file, "utf-8");
      if (importsAwsConfig(content)) {
        importers.push(relative(REPO_ROOT, file));
      }
    }

    const badImporters = importers.filter((f) => f !== ALLOWED_IMPORTER);

    expect(
      badImporters,
      `ADR-0003 violation: src/aws-config.ts must only be imported by ${ALLOWED_IMPORTER}.\n` +
        `Disallowed importer(s): ${badImporters.join(", ")}\n\n` +
        `WHY THIS IS BLOCKED:\n` +
        `Commit 18acb3c (PR #71 cycle 2) added a second import of src/aws-config.ts\n` +
        `into src/commands/whoami.ts to read region from ~/.aws/config. The hand-rolled\n` +
        `INI parser diverged from \`aws configure get region\` in six measured ways.\n` +
        `One divergence reported the wrong region value with confidence (credentials-file\n` +
        `wins over config-file in botocore, but the parser read only the config file).\n` +
        `Five others re-created #70's "region: unknown" bug for configs the parser\n` +
        `could not handle. It cost a full review cycle to catch.\n\n` +
        `ADR-0003 says: any value aws-axi reports as fact about the running session must\n` +
        `come from the aws CLI, not from an independent re-parse of AWS config files.\n` +
        `If you need diagnostic profile information (for an error message), route it\n` +
        `through src/aws.ts's enrichNoCredsError — do NOT import src/aws-config.ts\n` +
        `from a command module directly.\n\n` +
        `See: docs/adr/0003-cli-delegation-for-reported-values.md`,
    ).toEqual([]);
  });

  it(`${ALLOWED_IMPORTER} still imports src/aws-config.ts (guard is not vacuous)`, () => {
    const awsTsContent = readFileSync(join(REPO_ROOT, ALLOWED_IMPORTER), "utf-8");
    expect(
      importsAwsConfig(awsTsContent),
      `${ALLOWED_IMPORTER} no longer imports src/aws-config.ts.\n` +
        `Update ALLOWED_IMPORTER in this test to reflect the new authorised importer,\n` +
        `or remove this test if src/aws-config.ts itself has been removed.\n` +
        `See: docs/adr/0003-cli-delegation-for-reported-values.md`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADR-0003 corollary — command/resolve modules must not import parseAwsError
// or mapAwsError directly from errors.ts
// ---------------------------------------------------------------------------
//
// WHY THIS GUARD EXISTS:
//
// After PR #71 closed the NO_PROFILE_SELECTED gap in awsExec and awsJson,
// three awsRaw consumers still called parseAwsError off the raw ExecResult
// (wait.ts, s3.ts, bucket.ts) and one called mapAwsError (lambda.ts). These
// missed the enrichNoCredsError call, so those paths emitted the old
// NO_CREDENTIALS + "Run `aws sso login`" message regardless of whether named
// profiles existed — exactly the silent-stop failure mode #70 was filed to fix.
//
// PR #72 structural fix: awsRaw now computes result.error (parsed + enriched
// ParsedAwsError) for every non-zero exit. Command/resolve modules read
// result.error directly — they have no reason to import parseAwsError or
// mapAwsError from errors.ts, and must not do so.
//
// This guard is a backstop for the most common regression shape (static imports
// of parseAwsError / mapAwsError in commands / resolve dirs). Dynamic imports
// and namespace imports are not caught here; the structural guarantee in awsRaw
// (result.error always populated) is the primary defense against those shapes.
//
// If a new src/commands/*.ts or src/resolve/*.ts file imports parseAwsError or
// mapAwsError from errors.ts, this test fails with a clear explanation.

const COMMANDS_DIR = join(REPO_ROOT, "src", "commands");
const RESOLVE_DIR = join(REPO_ROOT, "src", "resolve");

/**
 * Detect a direct import of parseAwsError or mapAwsError from errors.ts
 * in a TypeScript source file.
 */
function importsRawErrorParsers(content: string): boolean {
  // Matches import { ..., parseAwsError, ... } or import { ..., mapAwsError, ... }
  // from a relative path containing "errors" (with or without .js extension).
  return /import\s*\{[^}]*\b(?:parseAwsError|mapAwsError)\b[^}]*\}\s*from\s+["'][^"']*\/errors(?:\.js)?["']/.test(
    content,
  );
}

describe("ADR-0003 corollary — command/resolve modules must not import parseAwsError or mapAwsError from errors.ts", () => {
  it("no src/commands/*.ts file imports parseAwsError or mapAwsError from errors.ts", () => {
    const files = collectTsFiles(COMMANDS_DIR);
    const violators: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      if (importsRawErrorParsers(content)) {
        violators.push(relative(REPO_ROOT, file));
      }
    }

    expect(
      violators,
      `ADR-0003 corollary violation: src/commands/*.ts files must not import\n` +
        `parseAwsError or mapAwsError directly from errors.ts.\n` +
        `Violating file(s): ${violators.join(", ")}\n\n` +
        `WHY THIS IS BLOCKED:\n` +
        `Calling parseAwsError directly on an awsRaw ExecResult skips the\n` +
        `enrichNoCredsError upgrade that converts NO_CREDENTIALS to NO_PROFILE_SELECTED\n` +
        `when named profiles exist in ~/.aws/config. This recreates the exact silent-stop\n` +
        `failure mode that #70 was filed to fix.\n\n` +
        `FIX: awsRaw already computes result.error (a fully enriched ParsedAwsError)\n` +
        `for every non-zero exit. Read result.error directly — no extra imports needed.\n` +
        `Pass configPath in your AwsRunOptions so enrichment uses the correct config file.\n\n` +
        `See: docs/adr/0003-cli-delegation-for-reported-values.md`,
    ).toEqual([]);
  });

  it("no src/resolve/*.ts file imports parseAwsError or mapAwsError from errors.ts", () => {
    const files = collectTsFiles(RESOLVE_DIR);
    const violators: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      if (importsRawErrorParsers(content)) {
        violators.push(relative(REPO_ROOT, file));
      }
    }

    expect(
      violators,
      `ADR-0003 corollary violation: src/resolve/*.ts files must not import\n` +
        `parseAwsError or mapAwsError directly from errors.ts.\n` +
        `Violating file(s): ${violators.join(", ")}\n` +
        `FIX: read result.error from the awsRaw return value — it is already enriched.\n` +
        `Pass configPath in AwsRunOptions so enrichment uses the correct config file.\n` +
        `See the message from the commands/ check above for the full explanation.`,
    ).toEqual([]);
  });

  it("the guard is not vacuous — ExecResult.error carries the enriched ParsedAwsError (structural #72 guarantee)", () => {
    const awsTsContent = readFileSync(join(REPO_ROOT, "src", "aws.ts"), "utf-8");
    expect(
      awsTsContent,
      `ExecResult no longer has an 'error?' field in src/aws.ts.\n` +
        `The #72 structural fix requires awsRaw to compute and return the enriched\n` +
        `ParsedAwsError in result.error so no consumer can bypass enrichment.\n` +
        `If the field was renamed or removed, restore it and update all call sites.\n` +
        `See: docs/adr/0003-cli-delegation-for-reported-values.md`,
    ).toContain("readonly error?:");
  });
});
