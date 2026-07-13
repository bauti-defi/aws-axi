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
 *   collectPassthroughFlags(args, ownedFlags, ownedBoolFlags?)
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
 */

import { stripOutputFlag } from "./engine.js";
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
 *       keep it in passthrough.
 *       If the next token does NOT start with `--`, treat it as the flag's
 *       value and keep that too (consume it so it is not misread as a positional).
 *   - If the token does NOT start with `--` (bare positional):
 *       skip it — it is owned by the overlay.
 *
 * Limitation: unknown boolean flags (flags without a value, e.g. `--dry-run`)
 * followed immediately by a bare positional will consume that positional as their
 * value. This matches the same limitation already present in the overlays'
 * own `extractPositionals` helpers and is documented here for future reference.
 *
 * @param args           Raw args to scan (may include positionals + owned flags).
 * @param ownedFlagNames Flags the overlay parses with a value (e.g. "--max-items").
 * @param ownedBoolFlags Flags the overlay parses WITHOUT a following value token
 *                       (e.g. "--reveal", "--recursive"). These are skipped but
 *                       their next token is NOT consumed.
 */
export function collectPassthroughFlags(
  args: readonly string[],
  ownedFlagNames: ReadonlySet<string> | readonly string[],
  ownedBoolFlags?: ReadonlySet<string> | readonly string[],
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

    // Unknown (passthrough) flag: keep it.
    out.push(arg);

    if (eqIdx === -1) {
      // Two-arg form: look ahead for a value token.
      if (i + 1 < args.length) {
        const next = args[i + 1] ?? "";
        if (!next.startsWith("--")) {
          // Next token is the flag's value — consume and keep it.
          i++;
          out.push(next);
        }
        // else: next is another flag → this unknown flag has no value (boolean-like).
      }
    }
    // --flag=value form: value is embedded in `arg`, nothing extra to consume.
  }

  return out;
}
