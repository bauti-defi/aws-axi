/**
 * Shared arg-splitting seam for enriched overlays.
 *
 * Invariant: an overlay's INPUT contract must be a SUPERSET of the real aws CLI's.
 * Unrecognised flags are forwarded verbatim to the underlying aws invocation —
 * never rejected (hard error) and never silently dropped.
 *
 * This module provides the two building blocks every overlay needs:
 *
 *   buildPassthrough(remaining)
 *     Given the args AFTER the overlay has consumed its own known flags and
 *     positionals, strip --output (the exec seam always appends --output json),
 *     detect --query, and return passthrough + hasQuery.
 *
 *   collectPassthroughFlags(args, ownedFlags, ownedBoolFlags?, context?)
 *     Given the RAW overlay args (before any overlay parsing), strip the overlay's
 *     known flags and positionals, leaving only the flags that should be forwarded
 *     verbatim to the child aws invocation.
 *
 * --output contract
 *   Always stripped from passthrough. The exec seam (aws.ts buildArgs) always
 *   appends --output json; a user-supplied --output in passthrough would produce
 *   a duplicate --output conflict. stripOutputFlag (re-exported from engine.ts)
 *   handles both "--output value" (two-arg) and "--output=value" (equals) forms.
 *
 * --query contract
 *   JMESPath is applied by the aws CLI before we see the JSON, so the response
 *   shape is unknown and the overlay CANNOT safely project it. When --query is
 *   present, hasQuery=true signals that the overlay must bypass its curated
 *   projection and return the raw queried result as-is. --query IS kept in
 *   passthrough so the child aws CLI applies JMESPath correctly.
 *
 * ModelContext contract (collectPassthroughFlags)
 *   When context is provided, the botocore service model is used to classify
 *   KNOWN flags correctly — boolean flags do not consume the next token as a
 *   value, preventing positional-eating. Flags NOT found in the model are
 *   forwarded anyway (superset contract); the heuristic is used as fallback.
 *   When context is absent (or the model cannot be loaded), the function falls
 *   back to the heuristic for all unknown flags: consume the next non-`--`
 *   token as a flag value.
 */

import { AxiError } from "axi-sdk-js";
import { stripOutputFlag } from "./engine.js";
import {
  loadService,
  resolveOperationName,
  pascalToKebab,
  type ServiceModel,
} from "./model.js";

export { stripOutputFlag };

// ── Public types ──────────────────────────────────────────────────────────────

export interface OverlayArgSplit {
  /**
   * Args to forward verbatim to the underlying aws invocation.
   * --output is stripped; --query is kept.
   */
  readonly passthrough: string[];
  /**
   * True when --query was present in the source args.
   * Signals the overlay to bypass its curated projection and return raw output.
   */
  readonly hasQuery: boolean;
}

/**
 * Service + operation context for model-driven flag classification.
 * Used by collectPassthroughFlags to determine whether an unknown flag is
 * boolean (no value follows) or takes a value.
 */
export interface ModelContext {
  /** AWS service name as used by aws CLI (e.g. "ssm", "kms", "logs"). */
  readonly service: string;
  /** Operation name in kebab-case (e.g. "get-parameter", "list-keys"). */
  readonly operation: string;
}

// ── Global AWS CLI flag sets ──────────────────────────────────────────────────
//
// These flags are defined by the aws CLI itself and are NOT in any service
// botocore model. They apply to all operations and must be handled explicitly
// so that collectPassthroughFlags does not misclassify them.

/**
 * Global aws CLI flags that take NO value — boolean in nature.
 * Kept in passthrough verbatim; the next token is NOT consumed as a value.
 */
const GLOBAL_BOOL_FLAGS = new Set([
  "--debug",
  "--no-verify-ssl",
  "--no-paginate",
  "--no-sign-request",
  "--no-cli-pager",
  "--cli-auto-prompt",
  "--no-cli-auto-prompt",
  "--version",
]);

/**
 * Global aws CLI flags that TAKE a value.
 * Kept in passthrough verbatim; the next token IS consumed as the value.
 *
 * --output and --query have special overlay handling (--output is stripped;
 * --query sets hasQuery) but are included here so the model-driven path
 * never throws USAGE_ERROR for them.
 */
const GLOBAL_VALUE_FLAGS = new Set([
  "--output",      // stripped by stripOutputFlag / buildPassthrough
  "--query",       // kept; sets hasQuery in buildPassthrough
  "--endpoint-url",
  "--ca-bundle",
  "--cli-read-timeout",
  "--cli-connect-timeout",
  "--cli-binary-format",
  "--color",
  "--profile",     // normally stripped by context.ts; whitelisted for safety
  "--region",      // normally stripped by context.ts; whitelisted for safety
]);

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Determine whether a flag (in "--kebab-case" form) is boolean in the given
 * operation's botocore model.
 *
 * Uses `pascalToKebab` to match each param's PascalCase name against the
 * flag's kebab form — correctly handles acronyms (e.g. KMSKeyId → kms-key-id).
 *
 * @returns `true`      if the flag is a boolean parameter
 *          `false`     if it takes a value
 *          `undefined` if the flag is not found in the operation's input params
 */
function isModelBooleanFlag(
  flagName: string,
  model: ServiceModel,
  opKey: string,
): boolean | undefined {
  const op = model.operations.get(opKey);
  if (op === undefined) return undefined;
  const kebabParam = flagName.slice(2); // strip "--"
  const param = op.signature.inputParams.find(
    (p) => pascalToKebab(p.name) === kebabParam,
  );
  if (param === undefined) return undefined;
  return param.type === "boolean";
}

// ── locateFlag ───────────────────────────────────────────────────────────────

/**
 * Locate the first occurrence of a named flag in argv, returning its value and
 * the range of tokens it occupies.
 *
 * Accepts both forms agents commonly use:
 *   --flag value   → span 2 (flag token + separate value token)
 *   --flag=value   → span 1 (single combined token)
 *
 * Returns the first match (first-wins on repeated flags).
 * Returns `undefined` when the flag is absent OR when it is the final token
 * with no following value in two-arg form.
 *
 * Contract notes:
 *   - Does NOT mutate the input array.
 *   - Does NOT reject values that start with a single `-` (e.g. --limit=-1 is valid).
 *   - Throws USAGE_ERROR when the two-arg form's next token starts with `--`
 *     (e.g. `--flag --other-flag`): such tokens are unambiguously other flags,
 *     not values.  The error message names both the flag and the offending token.
 *     Use the equals form (`--flag=--value`) if a value genuinely starts with `--`.
 *   - The `=` suffix in the prefix check (`${flag}=`) prevents false matches
 *     against flags that share a prefix (e.g. --limit vs --limit-type).
 *
 * This is the single-scan foundation used by both `extractFlag` (read-only)
 * and `pullFlag` in logs.ts (extract-and-remove), ensuring a single parsing
 * contract underlies all value-extraction needs.
 */
export function locateFlag(
  args: readonly string[],
  flag: string,
): { readonly value: string; readonly start: number; readonly span: 1 | 2 } | undefined {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    // Two-arg form: --flag value
    if (arg === flag && i + 1 < args.length) {
      const next = args[i + 1] as string;
      if (next.startsWith("--")) {
        // The next token is another flag, not a value.  Consuming it would
        // silently mis-assign it and produce a confusing downstream error.
        // Throw immediately so the user sees the real problem.
        throw new AxiError(
          `${flag} requires a value but "${next}" looks like a flag, not a value`,
          "USAGE_ERROR",
          [
            `Use the equals form to avoid ambiguity: ${flag}=<value>`,
            `Or provide the value before the next flag: ${flag} <value> ${next} …`,
          ],
        );
      }
      return { value: next, start: i, span: 2 };
    }
    // Equals form: --flag=value (or --flag= for empty value)
    if (arg.startsWith(eqPrefix)) {
      return { value: arg.slice(eqPrefix.length), start: i, span: 1 };
    }
  }
  return undefined;
}

// ── hasFlag ───────────────────────────────────────────────────────────────────

/**
 * Return true if a named flag is present anywhere in argv.
 *
 * Accepts both forms:
 *   --flag          (boolean / presence-only use)
 *   --flag=value    (equals form — still counts as present)
 *   --flag value    (two-arg form — the flag token itself is present)
 *
 * The `=` suffix in the prefix check prevents false matches against flags that
 * share a name prefix (e.g. --recursive vs --recursive-list-item, unlikely but
 * safe by construction).
 *
 * This is the shared implementation that replaces the three private copies in
 * secrets.ts / ssm.ts (correct form) and s3.ts (broken `includes`-only form).
 */
export function hasFlag(args: readonly string[], flag: string): boolean {
  const eqPrefix = `${flag}=`;
  return args.some((a) => a === flag || a.startsWith(eqPrefix));
}

// ── flagIsTrue ────────────────────────────────────────────────────────────────

/**
 * Return true if a named BOOLEAN flag is enabled in argv.
 *
 * Unlike `hasFlag` (presence-only), this helper is VALUE-AWARE and must be
 * used for semantic booleans whose value must be respected on write paths
 * (currently: --dryrun and --recursive in s3).
 *
 * Accepted inputs and their interpretation:
 *   --flag            → true   (bare presence implies enabled)
 *   --flag true       → true   (two-arg form; recognised true literal)
 *   --flag false      → false  (two-arg form; recognised false literal)
 *   --flag 0 / no     → false  (two-arg form; recognised false literals)
 *   --flag <other>    → true   (two-arg; unrecognised non-bool → bare-presence)
 *   --flag=true       → true
 *   --flag=1          → true
 *   --flag=yes        → true
 *   --flag=<other>    → true   (any unrecognised =value is treated as truthy)
 *   --flag=false      → false  (superset extension: real aws hard-errors here)
 *   --flag=0          → false
 *   --flag=no         → false
 *   (absent)          → false
 *
 * ADR-0002 contract: aws-axi is a strict SUPERSET of real aws — it accepts
 * input that real aws rejects and honours it sensibly.  `--flag=false` is
 * rejected by real aws (e.g. `aws s3 cp … --dryrun=false` →
 * "argument --dryrun: ignored explicit argument 'false'"), but silently
 * treating it as true (the `hasFlag` behaviour) would INVERT user intent on
 * a write path and report success.  Treating it as false is the only option
 * that does not silently corrupt behaviour.
 *
 * Use this ONLY for semantic booleans.  For guard call sites that throw
 * regardless of the flag value (e.g. --bucket-name-prefix on the object
 * listing path), `hasFlag` is correct — presence is all that matters there.
 *
 * First-wins on repeated flags (consistent with every other parser in this
 * file).  The `=` prefix guard prevents false matches against flags sharing
 * a name prefix (e.g. --dryrun vs --dryrun-mode).
 */
export function flagIsTrue(args: readonly string[], flag: string): boolean {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === flag) {
      // Two-arg form: peek at the next token.
      //   Recognised false literals (false/0/no, case-insensitive) → false
      //   Recognised true  literals (true/1/yes)                   → true
      //   Absent, another --flag, or any non-bool positional        → bare-presence → true
      //
      // Only recognised boolean literals are consumed as the flag's value;
      // non-bool positionals (e.g. a secret-id like "prod/db") are left alone.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const v = next.toLowerCase();
        if (v === "false" || v === "0" || v === "no") return false;
        if (v === "true" || v === "1" || v === "yes") return true;
      }
      return true; // bare presence
    }
    if (a.startsWith(eqPrefix)) {
      const v = a.slice(eqPrefix.length).toLowerCase();
      return v !== "false" && v !== "0" && v !== "no";
    }
  }
  return false;
}

// ── flagIsTrueStrict ──────────────────────────────────────────────────────────

/**
 * Return true ONLY if a named BOOLEAN flag is explicitly enabled in argv.
 *
 * This is the FAIL-SAFE variant of `flagIsTrue` for CONFIDENTIALITY flags
 * (e.g. `--reveal`).  Where `flagIsTrue` treats any unrecognised value as
 * truthy (fail-safe for write-guard flags: unrecognised ⇒ dry-run ⇒ no write),
 * this helper uses a whitelist: anything not in the known-true set is treated
 * as FALSE (fail-safe for confidentiality: unrecognised ⇒ redact, not reveal).
 *
 * Accepted inputs and their interpretation:
 *   --flag            → true   (bare presence implies enabled)
 *   --flag true       → true   (two-arg form; recognised true literal)
 *   --flag false      → false  (two-arg form; recognised false literal)
 *   --flag 0 / no     → false  (two-arg form; recognised false literals)
 *   --flag <other>    → true   (two-arg; unrecognised non-bool → bare-presence)
 *   --flag=true       → true   (case-insensitive)
 *   --flag=1          → true
 *   --flag=yes        → true
 *   --flag=false      → false  (explicit opt-out)
 *   --flag=0          → false
 *   --flag=no         → false
 *   --flag=<other>    → false  (unrecognised =value → fail-safe: REDACT)
 *   --flag=           → false  (empty value → fail-safe)
 *   (absent)          → false
 *
 * FAIL-SAFE DIRECTION: the two helpers differ only in their `=`-form
 * fallback.  For the two-arg form, both helpers treat unrecognised
 * non-bool tokens as bare-presence (→ true), leaving non-bool positionals
 * (e.g. a secret-id "prod/db") untouched.
 *
 * WHEN TO USE: whenever the flag controls secret or credential exposure.
 * Leaking on `--reveal=garbage` is a confidentiality violation; redacting is
 * always safe.  For write-guard flags (`--dryrun`, `--recursive`) where the
 * fail-safe is the opposite direction, use `flagIsTrue` instead.
 *
 * Interaction with #57: issue #57 proposes hard-erroring on unrecognised
 * boolean values for ALL boolean flags.  When that lands, both `flagIsTrue`
 * and `flagIsTrueStrict` will error before returning, making the fallback
 * difference moot.  Until then the two helpers serve different fail-safe
 * directions for `=`-form values; remove `flagIsTrueStrict` when #57 lands.
 *
 * First-wins on repeated flags.  Same `=`-prefix guard as `flagIsTrue`.
 */
export function flagIsTrueStrict(args: readonly string[], flag: string): boolean {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === flag) {
      // Two-arg form: same peek logic as flagIsTrue.
      // (Fail-safe direction differs ONLY in the =-form: unrecognised
      //  --flag=garbage → false here vs → true in flagIsTrue.)
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const v = next.toLowerCase();
        if (v === "false" || v === "0" || v === "no") return false;
        if (v === "true" || v === "1" || v === "yes") return true;
      }
      return true; // bare presence
    }
    if (a.startsWith(eqPrefix)) {
      const v = a.slice(eqPrefix.length).toLowerCase();
      return v === "true" || v === "1" || v === "yes";
    }
  }
  return false;
}

// ── extractPositionals ────────────────────────────────────────────────────────

/**
 * Recognised boolean literals for two-arg flag forms (case-insensitive).
 * Exactly mirrors the literal set used by `flagIsTrue` and `flagIsTrueStrict`.
 */
const BOOL_LITERALS = new Set(["true", "false", "1", "0", "yes", "no"]);

/**
 * Extract bare positionals from argv, skipping all flag tokens and their values.
 *
 * This is the boolean-aware replacement for the naive
 * `args.filter(a => !a.startsWith("-"))` pattern, which incorrectly treats
 * recognised boolean literals (e.g. `false`, `0`, `no`) as positionals when
 * they appear as the value token of a boolean flag in two-arg form
 * (`--dryrun false`), silently shifting every positional that follows.
 *
 * Algorithm (left-to-right scan):
 *   --flag=value form  → skip (value embedded in one token)
 *   --flag in booleanFlags:
 *       next token is a recognised boolean literal → consume both (skip flag + value)
 *       next token is absent or not a bool literal → skip flag only
 *   --flag in GLOBAL_BOOL_FLAGS (e.g. --no-cli-pager, --debug, --no-paginate,
 *       --no-verify-ssl) → boolean: skip flag only, next token is NOT a value.
 *       Keeping this consistent with collectPassthroughFlags (which already checks
 *       GLOBAL_BOOL_FLAGS) prevents global flags from eating the next positional.
 *   any other --flag   → value flag: skip it AND the following token
 *   bare token (no --)  → positional: push to result
 *
 * The "any other --flag" value-flag rule is the reason the `--exclude` bug
 * (reviewer follow-up) falls out of this fix for free: `--exclude *.log`
 * skips both tokens, leaving `*.log` out of the positional result.
 *
 * @param args         Raw argv to scan.
 * @param booleanFlags Set of flags that take NO separate value token in the
 *                     default (bare) case but MAY consume a recognised boolean
 *                     literal as a two-arg value.  Must be consistent with
 *                     `flagIsTrue`/`flagIsTrueStrict` for the same argv.
 *
 * Replaces the identical private copies in `secrets.ts` and `ssm.ts` (the
 * duplication that caused the `s3.ts` call-site to be missed in round-2).
 */
// Empty-set singleton used as the default when no caller-specific boolean flags exist
// (e.g. kms/lambda, which have no overlay-specific boolean flags of their own).
const EMPTY_BOOL_FLAGS: ReadonlySet<string> = new Set<string>();

export function extractPositionals(
  args: readonly string[],
  booleanFlags: ReadonlySet<string> = EMPTY_BOOL_FLAGS,
): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      // --flag=value form: value is embedded; nothing else to consume.
      continue;
    }
    if (arg.startsWith("--")) {
      if (booleanFlags.has(arg)) {
        // Boolean flag in the caller's set: may optionally carry a recognised
        // literal as a separate value token.
        const next = args[i + 1];
        if (
          next !== undefined &&
          !next.startsWith("--") &&
          BOOL_LITERALS.has(next.toLowerCase())
        ) {
          i++; // consume the bool value — it is NOT a positional
        }
        // The flag itself is not a positional; continue regardless.
        continue;
      }
      // Global aws CLI boolean flags (e.g. --no-cli-pager, --debug,
      // --no-paginate, --no-verify-ssl) take no value token.
      // They are not in the caller-supplied booleanFlags set because the
      // caller only lists its own overlay-specific boolean flags; but they
      // must not eat the next positional.  GLOBAL_BOOL_FLAGS is already
      // maintained for collectPassthroughFlags — reusing it here keeps the
      // two functions consistent.
      if (GLOBAL_BOOL_FLAGS.has(arg)) {
        continue;
      }
      // POSIX end-of-options separator: forward to child (collectPassthroughFlags
      // will keep it in passthrough since it is not in owned/bools), but do NOT
      // consume the following token as a "value". Without this guard, `--` hits
      // the unknown/value-flag branch below and the `i++` silently eats the next
      // positional — converting `s3 cp -- ./local.txt s3://bucket/key` into a
      // USAGE_ERROR (no destination). This maintains ADR-0002's superset contract:
      // real `aws` 2.33.13 accepts `--` and processes through; base (52fc4ce)
      // forwarded it verbatim.
      if (arg === "--") {
        continue;
      }
      // Unknown / value flag: skip this token and the next (the value).
      i++;
      continue;
    }
    if (arg !== "") {
      result.push(arg);
    }
  }
  return result;
}

// ── resolveKeyArg ────────────────────────────────────────────────────────────

/**
 * Resolve a key argument that real `aws` accepts only as a named flag
 * (e.g. --role-name, --policy-arn) but aws-axi historically also accepted
 * as a bare positional.
 *
 * Under ADR-0002 (superset input contract), BOTH forms are accepted:
 *   <value>              bare positional — aws-axi extension; real aws rejects this
 *   --<flag> <value>     flag form       — real aws's only accepted form
 *   --<flag>=<value>     equals form     — real aws's equals variant
 *
 * Error cases (all → USAGE_ERROR):
 *   conflict   — both positional AND flag supplied in the same call; message
 *                names both conflicting values so the caller knows what to fix.
 *   duplicate  — same flag appears twice; real aws uses last-wins but aws-axi
 *                uses first-wins via locateFlag, so this now-reachable case
 *                would silently diverge. Reject instead so the caller is explicit.
 *   missing    — neither form provided.
 *
 * Uses extractPositionals() so flag values (e.g. "my-role" in "--role-name
 * my-role") are never mis-identified as the positional argument.
 *
 * See also: #63 — lambda get-function and get-function-configuration have the
 * same positional-only defect. When implementing, call resolveKeyArg AND add
 * the flag name to ownedFlagNames in the collectPassthroughFlags() call for
 * each operation (omitting it causes the key flag to be double-forwarded to
 * the child aws invocation).
 */
export function resolveKeyArg({
  args,
  flagName,
  label,
  examples,
}: {
  readonly args: readonly string[];
  readonly flagName: string;
  readonly label: string;
  readonly examples: readonly string[];
}): string {
  // Detect duplicate flags: real aws uses last-wins; aws-axi uses first-wins
  // (via locateFlag). Newly reachable via the flag-form fix — reject explicitly
  // so the caller is not surprised by silent divergence from real aws behaviour.
  const eqPrefix = `${flagName}=`;
  let flagCount = 0;
  for (const arg of args) {
    if (arg === flagName || arg.startsWith(eqPrefix)) {
      flagCount++;
    }
  }
  if (flagCount >= 2) {
    throw new AxiError(
      `${flagName} appears ${flagCount} times. Provide it exactly once.`,
      "USAGE_ERROR",
      [...examples],
    );
  }

  // extractPositionals() correctly skips flag values (e.g. "my-role" in
  // "--role-name my-role" is NOT returned as a positional — it is consumed
  // as the value of the preceding flag). See extractPositionals for the full
  // algorithm.
  const positionals = extractPositionals(args);
  const positional = positionals[0] as string | undefined;

  // Flag form: --flag value  or  --flag=value
  const flagLoc = locateFlag(args, flagName);
  const flagValue = flagLoc?.value;

  // Conflict: both forms in the same call — real aws cannot hit this (it does
  // not accept positionals for these operations) so we define the policy:
  // USAGE_ERROR naming both values, forcing the caller to pick one form.
  if (positional !== undefined && flagValue !== undefined) {
    throw new AxiError(
      `Conflicting ${label}: positional '${positional}' and ${flagName} '${flagValue}'. Provide one form only.`,
      "USAGE_ERROR",
      [...examples],
    );
  }

  const value = positional ?? flagValue;
  if (value === undefined) {
    throw new AxiError(
      `${label} is required: provide it positionally or as ${flagName}`,
      "USAGE_ERROR",
      [...examples],
    );
  }

  return value;
}

// ── extractFlag ──────────────────────────────────────────────────────────────

/**
 * Extract the value of a named flag from argv (read-only).
 *
 * Delegates to `locateFlag` — same parsing contract, returns the value only.
 *
 * Accepts both forms:
 *   --flag value   (space-separated)
 *   --flag=value   (equals-separated, including --flag= for an empty value)
 *
 * Returns the first match (first-wins on repeated flags).
 * Returns `undefined` when the flag is absent OR when it is the final token
 * with no following value in two-arg form.
 *
 * This is the shared implementation that replaced the four identical private
 * `extractFlag` copies in kms.ts / lambda.ts / secrets.ts / ssm.ts (PR #51).
 * The logs.ts `pullFlag` uses `locateFlag` directly for its extract-and-remove
 * contract (it must also return the remaining array with consumed tokens removed).
 */
export function extractFlag(
  args: readonly string[],
  flag: string,
): string | undefined {
  return locateFlag(args, flag)?.value;
}

// ── buildPassthrough ─────────────────────────────────────────────────────────

/**
 * Build passthrough from the args REMAINING after the overlay has consumed
 * its own known flags and positionals.
 *
 * - Strips `--output` / `--output=<value>` (exec seam appends `--output json`)
 * - Detects `--query` / `--query=<expr>` and sets `hasQuery=true`
 * - Returns everything else verbatim as passthrough
 */
export function buildPassthrough(remaining: readonly string[]): OverlayArgSplit {
  let hasQuery = false;
  for (const arg of remaining) {
    if (arg === "--query" || arg.startsWith("--query=")) {
      hasQuery = true;
      break;
    }
  }
  return { passthrough: stripOutputFlag(remaining), hasQuery };
}

// ── collectPassthroughFlags ──────────────────────────────────────────────────

/**
 * Collect the passthrough flags (and their values) from RAW overlay args,
 * stripping the overlay's own known flags and bare positionals.
 *
 * Used by overlay handlers that receive the full `args` and need to extract
 * passthrough without a clean "remainder" from prior flag parsing.
 *
 * Algorithm (left-to-right scan):
 *   - If the token is an overlay-owned flag:
 *       skip it (and its value token, unless it is a boolean/no-value flag).
 *   - If the token starts with `--` and is NOT owned:
 *       keep it in passthrough. Determine whether a value follows:
 *         1. Global boolean flags → no value consumed.
 *         2. Global value flags → consume next non-`--` token.
 *         3. Model lookup (when context provided) → use ShapeType when found.
 *            boolean → no value; other → consume next non-`--` token.
 *            Flag not in model → fall through to heuristic (step 4).
 *         4. No context / model unavailable → heuristic: consume next
 *            non-`--` token.
 *   - If the token does NOT start with `--` (bare positional):
 *       skip it — it is owned by the overlay.
 *
 * @param args           Raw args to scan (may include positionals + owned flags).
 * @param ownedFlagNames Flags the overlay parses with a value (e.g. "--max-items").
 * @param ownedBoolFlags Flags the overlay parses WITHOUT a following value token
 *                       (e.g. "--reveal", "--recursive"). These are skipped but
 *                       their next token is NOT consumed.
 * @param context        Optional service + operation context for model-based
 *                       boolean flag classification. Flags found in the model
 *                       are classified correctly; flags not found fall back to
 *                       the heuristic. No errors are thrown for unknown flags.
 */
export function collectPassthroughFlags(
  args: readonly string[],
  ownedFlagNames: ReadonlySet<string> | readonly string[],
  ownedBoolFlags?: ReadonlySet<string> | readonly string[],
  context?: ModelContext,
): string[] {
  const owned =
    ownedFlagNames instanceof Set
      ? ownedFlagNames
      : new Set<string>(ownedFlagNames);

  const bools =
    ownedBoolFlags === undefined
      ? new Set<string>()
      : ownedBoolFlags instanceof Set
        ? ownedBoolFlags
        : new Set<string>(ownedBoolFlags);

  // Pre-load the botocore model once when context is provided.
  // If loading fails, fall through to heuristic for all flags (graceful degradation).
  let serviceModel: ServiceModel | undefined;
  let resolvedOpKey: string | undefined;
  if (context !== undefined) {
    try {
      serviceModel = loadService(context.service);
      resolvedOpKey = resolveOperationName(serviceModel, context.operation) ?? undefined;
    } catch {
      serviceModel = undefined;
    }
  }

  const out: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";

    if (!arg.startsWith("--")) {
      // Bare positional — owned by the overlay; skip.
      continue;
    }

    // Determine the flag name (handle --flag=value form).
    const eqIdx = arg.indexOf("=");
    const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;

    if (owned.has(flagName)) {
      // Overlay-owned value flag: skip this token and its value.
      if (eqIdx === -1 && !bools.has(flagName) && i + 1 < args.length) {
        i++; // skip the value token
      }
      continue;
    }

    if (bools.has(flagName)) {
      // Overlay-owned boolean flag: skip only this token (no value follows).
      continue;
    }

    // ── Unknown (passthrough) flag ────────────────────────────────────────────
    out.push(arg);

    if (eqIdx !== -1) {
      // --flag=value form: value is embedded. Nothing else to consume.
      continue;
    }

    // Two-arg form: determine whether a value token follows.

    // Priority 1: global boolean flags — no value.
    if (GLOBAL_BOOL_FLAGS.has(flagName)) {
      continue;
    }

    // Priority 2: global value flags — consume next non-`--` token.
    if (GLOBAL_VALUE_FLAGS.has(flagName)) {
      if (i + 1 < args.length) {
        const next = args[i + 1] ?? "";
        if (!next.startsWith("--")) {
          i++;
          out.push(next);
        }
      }
      continue;
    }

    // Priority 3: service model lookup.
    // The model tells us whether a KNOWN flag is boolean (no value) or takes a
    // value — preventing boolean flags from eating the next positional. Flags
    // not found in the model are NOT an error: the model may be incomplete, and
    // the superset contract requires forwarding unknown flags verbatim. Fall
    // through to the heuristic (Priority 4) in that case.
    if (serviceModel !== undefined && resolvedOpKey !== undefined) {
      const isBool = isModelBooleanFlag(flagName, serviceModel, resolvedOpKey);

      if (isBool !== undefined) {
        if (!isBool) {
          // Value flag — consume the next non-`--` token.
          if (i + 1 < args.length) {
            const next = args[i + 1] ?? "";
            if (!next.startsWith("--")) {
              i++;
              out.push(next);
            }
          }
        }
        // Boolean: next token is NOT a value; do not consume.
        continue;
      }
      // isBool === undefined: flag not in model — fall through to heuristic.
    }

    // Priority 4: no model context or model unavailable — use heuristic.
    // Consume the next non-`--` token as the flag's value.
    if (i + 1 < args.length) {
      const next = args[i + 1] ?? "";
      if (!next.startsWith("--")) {
        i++;
        out.push(next);
      }
    }
  }

  return out;
}
