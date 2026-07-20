/**
 * Characterization and regression tests for the shared argv-flag parsers
 * exported from overlay-args.ts (issues #51, closes #51).
 *
 * ── Complete parser inventory (verified by grep, 2026-07-14) ─────────────────
 *
 * Value extractors (return a string or splice + return string):
 *   1. locateFlag      overlay-args.ts     — foundation; returns { value, start, span }
 *   2. extractFlag     overlay-args.ts     — delegates to locateFlag; returns value only
 *   3. pullFlag        logs.ts (private)   — delegates to locateFlag; returns [value, remaining]
 *   4. parseMaxItems   ec2.ts (private)    — extract-and-remove with int validation
 *   5. parseNextToken  ec2.ts (private)    — extract-and-remove; has empty-value guard asymmetry
 *   6. extractNextToken iam.ts (private)   — extract-and-remove; both forms
 *   7. extractScope    iam.ts (private)    — extract-and-remove; both forms
 *   8. stripContextArgs context.ts         — strips --profile/--region; rejects empty =; own loop
 *   9. stripOutputFlag engine.ts           — strips --output; already re-exported from overlay-args
 *
 * Presence / boolean checkers (return boolean):
 *   10. hasFlag         overlay-args.ts  — presence-only; correct equals-form check
 *   11. flagIsTrue      overlay-args.ts  — value-aware boolean; superset semantics for =false
 *   12. isParamPresent  engine.ts        — PascalCase input; different entry contract
 *   13. hasMaxItemsFlag engine.ts        — hardcoded flag; presence only
 *   14. hasQueryFlag    engine.ts        — hardcoded flag; presence only
 *   15. inline --query  overlay-args.ts:buildPassthrough — hasFlag(args,"--query") inlined
 *       inline --query  logs.ts:~520     — same inline; two copies of a one-liner
 *       (counted as one logical unit — same contract, trivial; filed as follow-up)
 *
 * Total: 15 distinct implementations after this PR's consolidation (down from 16+ pre-PR).
 *
 * Items 1–3 share the same core parsing contract (via locateFlag).
 * Items 4–7 are correct (handle both forms) but use independent loops — DRY
 * debt deferred: parseMaxItems has inline int validation, parseNextToken has
 * an asymmetric empty-value guard (`arg.length > "--next-token=".length`) that
 * differs from locateFlag semantics; iam's parsers are single-module and not
 * cross-duplicated.
 * Items 9–11 are presence-only and engine-internal; their entry contracts differ
 * from hasFlag (PascalCase conversion, hardcoded flag names).
 *
 * Deleted in this PR:
 *   - extractFlag copies in kms.ts / lambda.ts / secrets.ts / ssm.ts (PR #55 base)
 *   - parseFlag in s3.ts (BUGGY: indexOf-only → equals form silently dropped)
 *   - hasFlag  in s3.ts (BUGGY: includes-only → equals form silently dropped)
 *   - hasFlag  in secrets.ts (correct form; now unified under overlay-args)
 *   - hasFlag  in ssm.ts    (correct form; now unified under overlay-args)
 *
 * Call sites (grep-verified):
 *   extractFlag: 39 total — kms(7) + lambda(7) + secrets(5) + ssm(13) + s3(6) + logs(1 via pullFlag)
 *   hasFlag:     17 total — s3(11) + ssm(5) + secrets(1)
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
 * Edge case                          | extractFlag | pullFlag (value) | isParamPresent
 * -----------------------------------|-------------|------------------|----------------
 * --flag=value                       | "value"     | "value"          | true
 * --flag value                       | "value"     | "value"          | true
 * --flag=                            | ""          | ""               | true
 * --flag=-1                          | "-1"        | "-1"             | true
 * --flag -1                          | "-1"        | "-1"             | true
 * --flag (final token)               | undefined   | undefined        | true  ← diff
 * --flag a --flag b                  | "a"         | "a"              | true  (first-wins)
 * --flag --other                     | "--other"   | "--other"        | true
 * --limit when --limit-type=val      | undefined   | undefined        | false
 * Mutates argv?                      | no          | yes (splice)     | no
 *
 * extractFlag vs isParamPresent on "--flag" (final): isParamPresent returns
 * true (flag IS present), extractFlag returns undefined (no value follows).
 * NOT a consolidation opportunity — different contracts. No call-site changes.
 *
 * ── Revert-proof table (semantic mutations → catching tests) ─────────────────
 *
 * # | Mutation applied                                  | Suite result | Caught by
 * --|---------------------------------------------------|-------------|----------------------------------------------
 * M1| Remove the equals-form (--flag=value) branch     | RED 10 fail | "equals form" ×5, agreement matrix,
 *   |   from extractFlag/locateFlag                     |             | _extractTailArgs (--since=1h),
 *   |                                                   |             | _extractFilterArgs (--limit=5),
 *   |                                                   |             | kmsRun --max-items=N, kmsRun --policy-name=custom
 * M2| Last-wins instead of first-wins on repeated flags | RED  3 fail | first-wins (equals form), first-wins
 *   |                                                   |             | (two-arg form), agreement matrix
 * M3| --flag at end-of-argv returns "" instead of       | RED  2 fail | "returns undefined when flag is the final
 *   |   undefined                                       |             | token", agreement matrix
 * M4| Break prefix guard (--limit matches --limit-type) | RED  2 fail | "does NOT false-match a flag that is a
 *   |                                                   |             | prefix of another", agreement matrix
 */

import { describe, it, expect } from "bun:test";
import { extractFlag, locateFlag, hasFlag, flagIsTrue, flagIsTrueStrict } from "../src/overlay-args.js";
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

// ── locateFlag ────────────────────────────────────────────────────────────────
//
// locateFlag is the single-scan foundation for both extractFlag (read-only)
// and pullFlag (extract-and-remove in logs.ts).  These tests pin the shape
// of the returned match object and confirm extractFlag delegates correctly.

describe("locateFlag — two-arg form", () => {
  it("returns { value, start, span:2 } for --flag value", () => {
    // RED if span is wrong: pullFlag would splice the wrong number of tokens.
    const m = locateFlag(["--flag", "value"], "--flag");
    expect(m).toStrictEqual({ value: "value", start: 0, span: 2 });
  });

  it("start reflects the correct index when the flag is not first", () => {
    // RED if start is wrong: remaining splice produces incorrect array.
    const m = locateFlag(["--other", "x", "--flag", "val"], "--flag");
    expect(m).toStrictEqual({ value: "val", start: 2, span: 2 });
  });

  it("returns undefined when flag is the final token (no value follows)", () => {
    expect(locateFlag(["--flag"], "--flag")).toBeUndefined();
  });

  it("returns first match only (first-wins)", () => {
    const m = locateFlag(["--flag", "a", "--flag", "b"], "--flag");
    expect(m?.value).toBe("a");
    expect(m?.start).toBe(0);
  });
});

describe("locateFlag — equals form", () => {
  it("returns { value, start, span:1 } for --flag=value", () => {
    // RED if span is 2: pullFlag would splice 2 tokens for a single-token form,
    // removing the token that follows --flag=value.
    const m = locateFlag(["--flag=value"], "--flag");
    expect(m).toStrictEqual({ value: "value", start: 0, span: 1 });
  });

  it("returns empty string for --flag= (empty value, span:1)", () => {
    const m = locateFlag(["--flag="], "--flag");
    expect(m).toStrictEqual({ value: "", start: 0, span: 1 });
  });

  it("does NOT false-match a flag that shares a name prefix (--limit vs --limit-type)", () => {
    // The eqPrefix check uses `${flag}=` which requires the full flag name before =.
    expect(locateFlag(["--limit-type=val"], "--limit")).toBeUndefined();
  });

  it("start reflects the correct index when the flag is not first", () => {
    const m = locateFlag(["--other=x", "--flag=v"], "--flag");
    expect(m).toStrictEqual({ value: "v", start: 1, span: 1 });
  });
});

describe("locateFlag — extractFlag delegation", () => {
  it("extractFlag(args, flag) === locateFlag(args, flag)?.value for every case", () => {
    // Proves extractFlag is a thin wrapper with no added logic.
    const cases: [readonly string[], string][] = [
      [["--flag=value"], "--flag"],
      [["--flag", "value"], "--flag"],
      [["--flag="], "--flag"],
      [["--flag"], "--flag"],
      [[], "--flag"],
      [["--limit-type=val"], "--limit"],
    ];
    for (const [args, flag] of cases) {
      expect(extractFlag(args, flag)).toStrictEqual(locateFlag(args, flag)?.value);
    }
  });
});

// ── hasFlag ───────────────────────────────────────────────────────────────────
//
// hasFlag replaces three private copies: secrets.ts (correct form), ssm.ts
// (correct form), and s3.ts (broken `includes`-only form that missed equals form).

describe("hasFlag — presence detection", () => {
  it("returns true for exact token match --flag", () => {
    // RED if only equals form is checked.
    expect(hasFlag(["--flag"], "--flag")).toBe(true);
  });

  it("returns true for --flag=value (equals form)", () => {
    // RED for the old s3.ts `includes`-only hasFlag — this was the live bug.
    // includes(["--flag=value"], "--flag") returns false.
    expect(hasFlag(["--flag=value"], "--flag")).toBe(true);
  });

  it("returns true for --flag= (empty value, equals form)", () => {
    expect(hasFlag(["--flag="], "--flag")).toBe(true);
  });

  it("returns false when only a prefix-sharing flag is present", () => {
    // --flag-extra is NOT the same flag as --flag.
    expect(hasFlag(["--flag-extra"], "--flag")).toBe(false);
  });

  it("returns false when flag is absent", () => {
    expect(hasFlag(["--other", "value"], "--flag")).toBe(false);
  });

  it("returns false for empty argv", () => {
    expect(hasFlag([], "--flag")).toBe(false);
  });

  it("returns true when flag appears in a longer argv (not the first token)", () => {
    expect(hasFlag(["--other", "x", "--flag=yes"], "--flag")).toBe(true);
  });

  it("does NOT false-match --bucket-name-prefix when checking --bucket", () => {
    // The eqPrefix guard prevents prefix collision.
    // hasFlag(["--bucket-name-prefix=foo"], "--bucket") must be false.
    expect(hasFlag(["--bucket-name-prefix=foo"], "--bucket")).toBe(false);
  });
});

// ── flagIsTrue ────────────────────────────────────────────────────────────────
//
// flagIsTrue is the value-aware boolean helper introduced in PR #55 round-3
// to fix the --dryrun=false inversion bug on s3 write paths.
//
// It replaces the three `hasFlag` calls at s3.ts:(recursive),(cp dryRun),(rm dryRun)
// that were previously presence-only and therefore inverted the boolean when the
// caller wrote --flag=false (the form LLM agents routinely emit from boolean schemas).
//
// Semantic decision (ADR-0002 superset): real aws hard-errors on --dryrun=false
// ("argument --dryrun: ignored explicit argument 'false'").  aws-axi accepts it
// and honours =false as false.  This is the only interpretation that does not
// silently corrupt write paths.
//
// Revert-proof mutations applied during development:
//   R1: Delete the `a === flag` branch entirely
//       → bare `--flag` no longer detected → tests "bare flag" and "bare flag
//         first-wins" go RED.
//   R2: Swap the falsy-value list to `["true","1","yes"]` (invert logic)
//       → "=true returns true" goes RED immediately.
//   R3: Delete the `a.startsWith(eqPrefix)` branch
//       → `--flag=false` not detected → "=false returns false" goes RED.
//   R4: Change falsy list to omit "false" (only "0" and "no" remain)
//       → "=false returns false" goes RED.
// All 4 mutations are caught by the unit tests below.

describe("flagIsTrue", () => {
  // ── truthy inputs ───────────────────────────────────────────────────────────

  it("bare --flag returns true (presence implies enabled)", () => {
    expect(flagIsTrue(["--flag"], "--flag")).toBe(true);
  });

  it("--flag=true returns true", () => {
    expect(flagIsTrue(["--flag=true"], "--flag")).toBe(true);
  });

  it("--flag=1 returns true", () => {
    expect(flagIsTrue(["--flag=1"], "--flag")).toBe(true);
  });

  it("--flag=yes returns true", () => {
    expect(flagIsTrue(["--flag=yes"], "--flag")).toBe(true);
  });

  it("unrecognised =value is treated as truthy (safe default)", () => {
    // Any value not in the explicit falsy list is truthy.
    expect(flagIsTrue(["--flag=maybe"], "--flag")).toBe(true);
    expect(flagIsTrue(["--flag=TRUE"], "--flag")).toBe(true); // case-insensitive → truthy
    // "true" lowercased → truthy; "True" lowercased → "true" → truthy
  });

  // ── falsy inputs ────────────────────────────────────────────────────────────

  it("--flag=false returns false (superset: real aws rejects this; we honour it)", () => {
    expect(flagIsTrue(["--flag=false"], "--flag")).toBe(false);
  });

  it("--flag=0 returns false", () => {
    expect(flagIsTrue(["--flag=0"], "--flag")).toBe(false);
  });

  it("--flag=no returns false", () => {
    expect(flagIsTrue(["--flag=no"], "--flag")).toBe(false);
  });

  it("absent flag returns false", () => {
    expect(flagIsTrue(["--other", "value"], "--flag")).toBe(false);
    expect(flagIsTrue([], "--flag")).toBe(false);
  });

  // ── case-insensitive falsy check ────────────────────────────────────────────

  it("--flag=False and --flag=FALSE are both false (case-insensitive)", () => {
    expect(flagIsTrue(["--flag=False"], "--flag")).toBe(false);
    expect(flagIsTrue(["--flag=FALSE"], "--flag")).toBe(false);
  });

  it("--flag=NO and --flag=No are both false (case-insensitive)", () => {
    expect(flagIsTrue(["--flag=NO"], "--flag")).toBe(false);
    expect(flagIsTrue(["--flag=No"], "--flag")).toBe(false);
  });

  // ── first-wins on repeated flags ────────────────────────────────────────────

  it("first occurrence wins: --flag=false --flag=true → false", () => {
    expect(flagIsTrue(["--flag=false", "--flag=true"], "--flag")).toBe(false);
  });

  it("first occurrence wins: bare --flag before --flag=false → true", () => {
    expect(flagIsTrue(["--flag", "--flag=false"], "--flag")).toBe(true);
  });

  // ── prefix guard ────────────────────────────────────────────────────────────

  it("does NOT false-match --dryrun-mode=false when checking --dryrun", () => {
    // The eqPrefix guard (${flag}=) ensures prefix-sharing flags are not confused.
    expect(flagIsTrue(["--dryrun-mode=false"], "--dryrun")).toBe(false);
    // "false" here is from the absent flag path, not the falsy-value path.
  });

  it("does NOT false-match --recursive-list-item when checking --recursive", () => {
    expect(flagIsTrue(["--recursive-list-item"], "--recursive")).toBe(false);
  });

  // ── mixed-argv (non-first position) ─────────────────────────────────────────

  it("detects --flag=false in a longer argv", () => {
    expect(flagIsTrue(["s3://bucket/", "--other", "--flag=false", "--another"], "--flag")).toBe(false);
  });

  it("detects bare --flag in a longer argv", () => {
    expect(flagIsTrue(["--other", "val", "--flag", "--next"], "--flag")).toBe(true);
  });

  // ── two-arg form (--flag false / --flag 0 / --flag no) ─────────────────────
  //
  // RED before fix: the loop short-circuited on `if (a === flag) return true`
  // before ever inspecting the next token.  All two-arg forms returned true
  // regardless of value — the same value-blind bug that `hasFlag` had for the
  // equals form.

  it("--flag false (two-arg) returns false — was leaking before fix", () => {
    // RED on 52fc4ce (pre-fix): returned true (bare-presence short-circuit)
    expect(flagIsTrue(["--flag", "false"], "--flag")).toBe(false);
  });

  it("--flag 0 (two-arg) returns false", () => {
    expect(flagIsTrue(["--flag", "0"], "--flag")).toBe(false);
  });

  it("--flag no (two-arg) returns false", () => {
    expect(flagIsTrue(["--flag", "no"], "--flag")).toBe(false);
  });

  it("--flag true (two-arg) returns true", () => {
    expect(flagIsTrue(["--flag", "true"], "--flag")).toBe(true);
  });

  it("--flag 1 (two-arg) returns true", () => {
    expect(flagIsTrue(["--flag", "1"], "--flag")).toBe(true);
  });

  it("--flag yes (two-arg) returns true", () => {
    expect(flagIsTrue(["--flag", "yes"], "--flag")).toBe(true);
  });

  it("--flag garbage (two-arg): unrecognised non-bool → bare-presence → true", () => {
    // 'garbage' is not a recognised bool literal; bare presence prevails.
    expect(flagIsTrue(["--flag", "garbage"], "--flag")).toBe(true);
  });

  it("--flag followed by another --flag (two-arg): next is a flag → bare-presence → true", () => {
    // Next token starts with '--'; not consumed as a value.
    expect(flagIsTrue(["--flag", "--other", "val"], "--flag")).toBe(true);
  });

  it("trailing --flag (two-arg, no next token): bare-presence → true", () => {
    expect(flagIsTrue(["positional", "--flag"], "--flag")).toBe(true);
  });

  it("two-arg false in a longer argv (flag-last)", () => {
    // Real use-case: prod/db is the positional before the flag
    expect(flagIsTrue(["prod/db", "--flag", "false"], "--flag")).toBe(false);
  });

  it("two-arg false in a longer argv (flag-first): value consumed correctly", () => {
    // flag-first form: --flag false positional
    expect(flagIsTrue(["--flag", "false", "prod/db"], "--flag")).toBe(false);
  });

  it("case-insensitive two-arg: --flag FALSE → false", () => {
    expect(flagIsTrue(["--flag", "FALSE"], "--flag")).toBe(false);
  });

  it("case-insensitive two-arg: --flag True → true", () => {
    expect(flagIsTrue(["--flag", "True"], "--flag")).toBe(true);
  });
});

// ── flagIsTrueStrict — two-arg form ──────────────────────────────────────────
//
// flagIsTrueStrict is the FAIL-SAFE variant used for confidentiality flags
// (--reveal on secrets/SSM).  The fail-safe direction difference is only
// visible in the =-form: unrecognised =value → false (strict) vs true (non-strict).
// For the two-arg form, both helpers behave identically — unrecognised non-bool
// tokens remain bare-presence (→ true).

describe("flagIsTrueStrict — two-arg form (PR #58 blocker fix)", () => {
  // ── RED on pre-fix code (52fc4ce) ─────────────────────────────────────────
  //
  // These tests all returned true on the pre-fix branch because the loop
  // short-circuited on `if (a === flag) return true` before inspecting the next
  // token.  A caller who wrote `--reveal false` received reveal=true and got the
  // plaintext secret — the exact bypass #56 exists to prevent.

  it("--flag false (two-arg) returns false — was leaking before fix", () => {
    expect(flagIsTrueStrict(["--flag", "false"], "--flag")).toBe(false);
  });

  it("--flag 0 (two-arg) returns false", () => {
    expect(flagIsTrueStrict(["--flag", "0"], "--flag")).toBe(false);
  });

  it("--flag no (two-arg) returns false", () => {
    expect(flagIsTrueStrict(["--flag", "no"], "--flag")).toBe(false);
  });

  it("--flag FALSE (case-insensitive) returns false", () => {
    expect(flagIsTrueStrict(["--flag", "FALSE"], "--flag")).toBe(false);
  });

  // ── GREEN: must still reveal with explicit true literals ──────────────────

  it("--flag true (two-arg) returns true", () => {
    expect(flagIsTrueStrict(["--flag", "true"], "--flag")).toBe(true);
  });

  it("--flag 1 (two-arg) returns true", () => {
    expect(flagIsTrueStrict(["--flag", "1"], "--flag")).toBe(true);
  });

  it("--flag yes (two-arg) returns true", () => {
    expect(flagIsTrueStrict(["--flag", "yes"], "--flag")).toBe(true);
  });

  // ── Unrecognised non-bool → bare-presence → true ──────────────────────────
  //
  // 'garbage' is not a recognised bool literal.  In two-arg form, unrecognised
  // non-bool tokens are treated as bare presence (consistent with: the flag
  // appeared, and its next token is a separate positional, not a value).
  // This is the same behaviour as flagIsTrue for two-arg form — the fail-safe
  // difference only applies to the =-form (--flag=garbage → false here).

  it("--flag garbage (two-arg): unrecognised → bare-presence → true", () => {
    expect(flagIsTrueStrict(["--flag", "garbage"], "--flag")).toBe(true);
  });

  // ── Boundary cases ────────────────────────────────────────────────────────

  it("trailing --flag (no next token): bare-presence → true", () => {
    expect(flagIsTrueStrict(["positional", "--flag"], "--flag")).toBe(true);
  });

  it("--flag followed by another --flag: next starts with -- → bare-presence → true", () => {
    expect(flagIsTrueStrict(["--flag", "--query", "SecretString"], "--flag")).toBe(true);
  });

  it("flag-last form with positional: --reveal false prod/db → false", () => {
    // The secret-id positional (prod/db) comes BEFORE --reveal false.
    // After the fix, --reveal false → reveal=false (correct: redact).
    expect(flagIsTrueStrict(["prod/db", "--flag", "false"], "--flag")).toBe(false);
  });

  it("flag-first form: --flag false positional → false", () => {
    expect(flagIsTrueStrict(["--flag", "false", "prod/db"], "--flag")).toBe(false);
  });

  // ── =-form still behaves strictly (fail-safe for confidentiality) ─────────

  it("--flag=garbage (=-form) → false (strict fail-safe)", () => {
    expect(flagIsTrueStrict(["--flag=garbage"], "--flag")).toBe(false);
  });

  it("--flag=off (=-form) → false (strict fail-safe)", () => {
    expect(flagIsTrueStrict(["--flag=off"], "--flag")).toBe(false);
  });

  it("--flag=true (=-form) → true", () => {
    expect(flagIsTrueStrict(["--flag=true"], "--flag")).toBe(true);
  });
});
