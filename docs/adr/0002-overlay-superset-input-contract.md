# ADR-0002: Overlay input contract — superset of the real aws CLI

**Status:** Accepted  
**Date:** 2026-07-13  
**Slice:** #33 (Overlay passthrough)

## Context

aws-axi hand-polished overlays (ec2, iam, s3, logs, kms, lambda, ssm,
secretsmanager) project verbose AWS JSON output down to curated TOON. Before
this ADR, each overlay's input contract was a **subset** of the real `aws` CLI:

- **EC2** hard-rejected any flag it didn't know (e.g. `--filters`) with
  `USAGE_ERROR: Unknown flag`.
- **All other overlays** silently dropped unknown flags, so server-side
  filtering flags like `--path-prefix`, `--filters`, or `--grant-tokens`
  were swallowed without effect or error.

Both failure modes forced callers to fall back to raw `aws`, which defeats the
purpose of the overlay (no enrichment, no redaction, no pagination cap).

The proxy assumption in the original design was that overlays only need to
handle their curated flag set. In practice, agents and operators regularly
combine server-side filtering with curated output (e.g. list only running EC2
instances with enriched names, or list SSM parameters under a path with KMS
alias enrichment).

The correct invariant: **an overlay's input contract is a strict SUPERSET of the
real `aws` CLI's**. The overlay changes the *output*, never restricts the
*input*.

## Decision

All enriched overlays forward unknown flags verbatim to the underlying `aws`
invocation. Two flag classes are handled specially:

| Flag | Behavior |
|---|---|
| `--output <value>` / `--output=<value>` | **Stripped.** The exec seam (`awsJson`) always appends `--output json`; a duplicate `--output` from passthrough would conflict. |
| `--query <expr>` / `--query=<expr>` | **Kept in passthrough, projection bypassed.** JMESPath is applied by the aws CLI before the response reaches the overlay; the overlay CANNOT safely project a JMESPath result of unknown shape. `hasQuery=true` tells the overlay to skip its curated projection and return the raw queried result as-is. |

Positionals owned by the overlay (e.g. `<key-id>` for `kms describe-key`,
`<group-name>` for `logs filter`) are never leaked into passthrough.

## Implementation

Two shared helpers in `src/overlay-args.ts`:

**`buildPassthrough(remaining)`** — used by overlays (like EC2) that produce a
clean "remainder" after parsing their own flags. Strips `--output`, detects
`--query`, returns `{passthrough, hasQuery}`.

**`collectPassthroughFlags(args, ownedFlags, ownedBoolFlags?)`** — used by
overlays (IAM, KMS, SSM, logs, lambda, secrets) that use `extractFlag`-style
parsing on the full args. Scans left-to-right: skips owned flags and their
values, skips bare positionals, keeps all unknown flags (and their values).

Both helpers are composed: `collectPassthroughFlags` produces the raw passthrough
list; `buildPassthrough` strips `--output` and detects `--query`.

`stripOutputFlag` (from `engine.ts`, re-exported from `overlay-args.ts`) handles
both `--output value` (two-arg) and `--output=value` (equals) forms.

In `ec2Run`, the `options.passthrough` field is normalised (via `stripOutputFlag`)
before dispatch to handlers, so callers that pass passthrough directly (e.g. in
tests) get the same `--output` dedup guarantee as the CLI adapter path.

## Rationale

- **Principle of least surprise**: operators and agents expect `aws-axi iam
  list-roles --path-prefix /engineering` to work exactly like `aws iam list-roles
  --path-prefix /engineering` — just with a better output format.
- **Minimal scope**: the overlay only touches the output layer. Restricting input
  is an overreach with no upside and real downside (forces fallback to raw aws).
- **Composable enrichment + server-side filtering**: the most valuable use of
  overlays is combining server-side filters (reducing network and token cost)
  with enrichment (SG names, KMS aliases, redaction). Passthrough makes this
  possible without any special-casing per-flag.
- **`--query` is a special case**: JMESPath changes the response shape in a way
  the overlay cannot predict. Bypassing projection is the only safe option.

## Accepted tradeoffs

- **Unknown boolean flags followed by a bare positional** may consume that
  positional as their value. This matches the existing limitation in
  `extractPositionals` helpers across overlays. It is documented in the
  `collectPassthroughFlags` JSDoc.
- **Passthrough flags are not validated** against the botocore service model.
  An invalid flag in passthrough will cause the underlying `aws` invocation to
  fail with an error — this is the correct behavior (fail fast and loud).
- **Duplicate flags** (where the overlay adds a flag it also received via
  passthrough) are accepted; the `aws` CLI resolves them by using the last
  occurrence. This is intentional: server-side defaults set by the overlay can
  be overridden by an explicit passthrough value.
