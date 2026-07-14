/**
 * Characterization tests for the shared `extractFlag` implementation (issue #51).
 *
 * ── Background ────────────────────────────────────────────────────────────────
 *
 * Before this refactor, six independent argv helpers implemented the same
 * "pull --flag value or --flag=value out of argv" contract:
 *
 *   1. extractFlag  src/commands/kms.ts:207
 *   2. extractFlag  src/commands/lambda.ts:236
 *   3. extractFlag  src/commands/secrets.ts:185
 *   4. extractFlag  src/commands/ssm.ts:359
 *   5. pullFlag     src/commands/logs.ts:153   — same value algorithm; ALSO removes consumed tokens
 *   6. Engine scan  src/engine.ts (isParamPresent / hasMaxItemsFlag / hasQueryFlag)
 *                                               — PRESENCE only, not a value extractor
 *
 * Items 1–4 are byte-for-byte identical (verified by grep before this PR).
 * Item 5 shares the value-extraction algorithm but returns [value, filteredArray]
 * instead of value — a different contract, kept private in logs.ts.
 * Item 6 implements presence detection, not value extraction; it cannot be
 * unified with extractFlag without changing semantics (--flag at end returns
 * true for isParamPresent but undefined for extractFlag). It stays separate.
 *
 * ── Also deliberate non-consolidations ───────────────────────────────────────
 *
 * stripContextArgs (context.ts): strips --profile/--region from argv AND
 * REJECTS the empty "--profile=" form (arg.length > "--profile=".length guard).
 * This is different semantics from extractFlag (which accepts empty "=").
 * Left separate — different contract and different semantic for empty "=" form.
 *
 * stripOutputFlag (engine.ts / re-exported from overlay-args.ts): strips
 * --output from argv — a stripper, not a value extractor. Already shared
 * (re-exported). Left as-is.
 *
 * ── Characterization table (parser × edge-case matrix) ────────────────────────
 *
 * All 4 extractFlag implementations (kms/lambda/secrets/ssm) produce IDENTICAL
 * results on every edge case below. pullFlag (logs) agrees on VALUE but also
 * removes consumed tokens. isParamPresent (engine) differs only on the final-token
 * edge case (returns true where extractFlag returns undefined).
 *
 * Edge case            | extractFlag×4 | pullFlag (value) | isParamPresent
 * ---------------------|---------------|------------------|----------------
 * --flag=value         | "value"       | "value"          | true
 * --flag value         | "value"       | "value"          | true
 * --flag=              | ""            | ""               | true
 * --flag=-1            | "-1"          | "-1"             | true
 * --flag -1            | "-1"          | "-1"             | true
 * --flag (final)       | undefined     | undefined        | true  ← diff
 * --flag a --flag b    | "a"           | "a"              | true  (first-wins)
 * --flag --other       | "--other"     | "--other"        | true
 * --limit when --limit-type=val present | undefined | undefined | false
 * Mutates argv?        | no            | yes              | no
 *
 * Disagreements between the six parsers:
 *   extractFlag vs isParamPresent on "--flag" (final): isParamPresent returns
 *   true (flag IS present), extractFlag returns undefined (no value follows).
 *   This is NOT a consolidation opportunity — they serve different contracts.
 *   No call-site behavior changes.
 *
 * stripContextArgs vs extractFlag on "--flag=" (empty):
 *   stripContextArgs REJECTS it (length guard); extractFlag returns "".
 *   They serve different contracts; no consolidation.
 *
 * All four extractFlag duplicates AGREE on every edge case. Zero behavior
 * changes at any of the 30 call sites in kms/lambda/secrets/ssm.
 *
 * ── Revert-proof methodology ──────────────────────────────────────────────────
 *
 * RED: Remove `extractFlag` from overlay-args.ts → named import below fails at
 *      runtime → every test in this file goes RED.
 * GREEN: Export `extractFlag` from overlay-args.ts with the documented contract
 *        → all tests pass.
 *
 * Additional per-case revert proof: each test documents what specific WRONG
 * behavior would appear if the implementation regressed (e.g., if the = form
 * were not handled, tests checking --flag=value would return undefined, not "value").
 */

import { describe, it, expect } from "bun:test";
import { extractFlag } from "../src/overlay-args.js";
import { _extractTailArgs, _extractFilterArgs } from "../src/commands/logs.js";

// ── Reference implementation ────────────────────────────────────────────────
//
// Exact copy of extractFlag as it existed in kms.ts (and lambda.ts, secrets.ts,
// ssm.ts — all four byte-for-byte identical). Used to prove the shared
// implementation matches the original contract on every edge case below.
//
// Once the migration is complete the four duplicates are gone; this copy
// serves as the permanent characterization baseline in the test suite.
function refExtractFlag(
  args: readonly string[],
  flag: string,
): string | undefined {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === flag && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith(eqPrefix)) {
      return arg.slice(eqPrefix.length);
    }
  }
  return undefined;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Assert that `extractFlag` (shared) matches `refExtractFlag` (original) for
 * the given inputs, and matches `expected`.
 *
 * Using both assertions means:
 *   - If `extractFlag` is absent or broken → explicit assertion fails (RED).
 *   - If the reference is wrong (regression in understanding) → mismatch also fails.
 */
function assertExtractFlag(
  args: readonly string[],
  flag: string,
  expected: string | undefined,
): void {
  const shared = extractFlag(args, flag);
  const ref = refExtractFlag(args, flag);
  // Both the shared implementation and the reference must agree.
  expect(shared).toStrictEqual(expected);
  expect(ref).toStrictEqual(expected);
  expect(shared).toStrictEqual(ref);
}

// ── Edge-case matrix: extractFlag ────────────────────────────────────────────

describe("extractFlag — equals form (--flag=value)", () => {
  it("returns the value after = for a standard value", () => {
    // RED if = form handling is removed: would return undefined.
    assertExtractFlag(["--limit=50"], "--limit", "50");
  });

  it("recognises equals form embedded in a longer argv", () => {
    assertExtractFlag(
      ["--profile", "prod", "--limit=10", "--region", "us-east-1"],
      "--limit",
      "10",
    );
  });

  it("returns empty string for --flag= (empty value after =)", () => {
    // Edge case: user passes --limit= (no value). Returns "" not undefined.
    // A caller is responsible for rejecting the empty string if semantically invalid.
    assertExtractFlag(["--limit="], "--limit", "");
  });

  it("returns value that starts with - for --flag=-1", () => {
    // --flag=-1 is legal (e.g. --offset=-1). The = form passes it through intact.
    assertExtractFlag(["--flag=-1"], "--flag", "-1");
  });

  it("does NOT false-match a flag that is a prefix of another (--limit vs --limit-type)", () => {
    // "--limit-type=value".startsWith("--limit=") is false because
    // "limit-" differs from "limit=" at the 7th character.
    // RED if the startsWith check used "--limit" instead of "--limit=":
    //   "--limit-type=value".startsWith("--limit") → true → would return "-type=value".
    assertExtractFlag(["--limit-type=value"], "--limit", undefined);
  });

  it("returns first match when equals form appears twice (first-wins)", () => {
    assertExtractFlag(["--flag=first", "--flag=second"], "--flag", "first");
  });
});

describe("extractFlag — two-arg form (--flag value)", () => {
  it("returns the following token as the value", () => {
    // RED if two-arg form is not handled: would return undefined.
    assertExtractFlag(["--limit", "50"], "--limit", "50");
  });

  it("returns a negative number as a string (--flag -1)", () => {
    // The implementation does NOT check whether the next token starts with -.
    // This is the characterised contract: -1 is returned as "-1".
    assertExtractFlag(["--flag", "-1"], "--flag", "-1");
  });

  it("returns the NEXT token even when it starts with -- (--flag --other)", () => {
    // Documented latent behaviour: --flag --other returns "--other" as the value.
    // This is a known semantic hole (issue filed separately — see PR body).
    // Do NOT change this behaviour in this PR.
    assertExtractFlag(["--flag", "--other"], "--flag", "--other");
  });

  it("returns first match when two-arg form appears twice (first-wins)", () => {
    assertExtractFlag(["--flag", "a", "--flag", "b"], "--flag", "a");
  });

  it("returns undefined when flag is the final token (no value follows)", () => {
    // `i + 1 < args.length` fails at the last position, so the two-arg path
    // is not taken and the loop falls through → undefined.
    assertExtractFlag(["--flag"], "--flag", undefined);
  });

  it("returns undefined when flag is absent from argv entirely", () => {
    assertExtractFlag(["--other", "value"], "--flag", undefined);
  });

  it("returns undefined for empty argv", () => {
    assertExtractFlag([], "--flag", undefined);
  });
});

describe("extractFlag — non-mutation contract", () => {
  it("does NOT modify the input array", () => {
    const args = ["--flag", "value", "--other", "x"];
    const before = [...args];
    extractFlag(args, "--flag");
    // Prove the array is unchanged.
    expect(args).toStrictEqual(before);
  });

  it("extractFlag and refExtractFlag agree on every edge case in the matrix", () => {
    // Comprehensive agreement check: run both over the full matrix and compare.
    const cases: [readonly string[], string, string | undefined][] = [
      [["--flag=value"], "--flag", "value"],
      [["--flag", "value"], "--flag", "value"],
      [["--flag="], "--flag", ""],
      [["--flag=-1"], "--flag", "-1"],
      [["--flag", "-1"], "--flag", "-1"],
      [["--flag"], "--flag", undefined],
      [["--flag", "a", "--flag", "b"], "--flag", "a"],
      [["--flag", "--other"], "--flag", "--other"],
      [["--limit-type=val"], "--limit", undefined],
      [[], "--flag", undefined],
    ];
    for (const [args, flag, expected] of cases) {
      expect(extractFlag(args, flag)).toStrictEqual(expected);
      expect(refExtractFlag(args, flag)).toStrictEqual(expected);
    }
  });
});

// ── pullFlag agreement via exported _extractTailArgs ─────────────────────────
//
// pullFlag (logs.ts) uses the same value-extraction algorithm as extractFlag but
// ALSO removes the consumed tokens from the array. It is private to logs.ts and
// tested here indirectly through _extractTailArgs (which chains pullFlag calls).
//
// These tests confirm the EXTRACTED VALUES agree with extractFlag on overlapping
// inputs. The removal contract is verified by the positional-finding logic below.

describe("pullFlag (via _extractTailArgs) — value agreement with extractFlag", () => {
  it("--since=1h (equals form): extracted value matches extractFlag", () => {
    // If pullFlag did NOT handle = form, _extractTailArgs would leave --since=1h
    // unparsed and the undefined-since default (15m) would be used instead of 1h.
    // RED: remove equals-form handling from pullFlag → since is undefined, not "1h".
    const result = _extractTailArgs([
      "/aws/lambda/fn",
      "--since=1h",
      "--limit=10",
    ]);
    expect(result.since).toBe("1h");
    expect(result.limit).toBe(10);
    // Verify agreement with extractFlag on the same inputs.
    expect(extractFlag(["--since=1h"], "--since")).toBe("1h");
    expect(extractFlag(["--limit=10"], "--limit")).toBe("10");
  });

  it("--since 1h (two-arg form): extracted value matches extractFlag", () => {
    const result = _extractTailArgs(["/aws/lambda/fn", "--since", "1h"]);
    expect(result.since).toBe("1h");
    expect(extractFlag(["--since", "1h"], "--since")).toBe("1h");
  });

  it("flags consumed by pullFlag do NOT appear as the positional group name", () => {
    // pullFlag REMOVES the flag+value so they cannot be mistaken for positionals.
    // If pullFlag only READ (like extractFlag) and did NOT remove, the remaining
    // array would contain "--since" and "1h" which are not positionals.
    // _extractTailArgs looks for the first non-flag remaining token — without
    // removal, "1h" would be the logGroupName if pullFlag didn't strip them.
    //
    // Since pullFlag DOES strip, only "/aws/lambda/fn" remains after --since 1h.
    const result = _extractTailArgs(["--since", "1h", "/aws/lambda/fn"]);
    expect(result.logGroupName).toBe("/aws/lambda/fn");
    expect(result.since).toBe("1h");
  });
});

describe("pullFlag (via _extractFilterArgs) — value agreement with extractFlag", () => {
  it("--limit=5 (equals form) in filter: extracted value matches extractFlag", () => {
    const result = _extractFilterArgs(["/aws/lambda/fn", "ERROR", "--limit=5"]);
    expect(result.limit).toBe(5);
    expect(extractFlag(["--limit=5"], "--limit")).toBe("5");
  });
});
