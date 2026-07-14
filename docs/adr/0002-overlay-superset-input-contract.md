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
| `--query <expr>` / `--query=<expr>` | **Kept in passthrough, projection bypassed, page cap bypassed on `s3 ls`.** JMESPath is applied by the aws CLI before the response reaches the overlay; the overlay CANNOT safely project a JMESPath result of unknown shape. `hasQuery=true` tells the overlay's `*Run` helper to skip its curated projection. On the `s3 ls` paths (both list-buckets and list-objects-v2), `hasQuery=true` also suppresses `--max-items`: JMESPath projects `NextToken` away, so the cap would cause silent truncation with no signal to the caller. Without the cap, botocore auto-pages the complete result. The CLI adapter (`logsCommand`, `s3Command`, etc.) must also bypass its record-builder wrappers when `hasQuery=true` — if the adapter re-wraps a raw result, all fields become null. |

Positionals owned by the overlay (e.g. `<key-id>` for `kms describe-key`,
`<group-name>` for `logs filter`) are never leaked into passthrough.

## Implementation

Two shared helpers in `src/overlay-args.ts`:

**`buildPassthrough(remaining)`** — used by overlays (like EC2) that produce a
clean "remainder" after parsing their own flags. Strips `--output`, detects
`--query`, returns `{passthrough, hasQuery}`.

**`collectPassthroughFlags(args, ownedFlags, ownedBoolFlags?, context?)`** — used
by overlays (IAM, KMS, SSM, logs, lambda, secrets) that use `extractFlag`-style
parsing on the full args. Scans left-to-right: skips owned flags and their
values, skips bare positionals, keeps all unknown flags (and their values). When
`context` (`{service, operation}`) is provided, the botocore service model is
consulted to classify known flags as boolean or value-taking — preventing boolean
flags from accidentally consuming the next positional as their value. Flags not
found in the model fall back to the heuristic (consume next non-`--` token).

**S3 overlay** (`s3.ts`) uses a different pattern. The adapter strips already-
identified positionals (source, destination, target URI) from the args **before**
calling `collectPassthroughFlags`. Once positionals are removed, every remaining
bare token must be a flag value — making the arity heuristic safe by construction,
even without a botocore model. Each sub-operation forwards the collected passthrough
to the underlying `aws s3api` (for `ls`, `head-object`, `create-bucket`) or
`aws s3` (for `cp`, `rm`) invocation.

**S3 flag contract.** `s3 cp` and `s3 rm` use `aws s3` high-level commands, so
`aws s3`-level flags (`--recursive`, `--sse`, `--storage-class`, `--exclude`,
`--include`) are valid passthrough for those sub-commands.

`s3 ls` and `s3 head-object` rewrite to `s3api` operations. The superset invariant
holds for every flag that the underlying `s3api` operation accepts. Two categories
are deliberate, named exceptions — not scope boundaries:

**Named exceptions (deliberate input restrictions):**

| Flag | Exception path | Reason |
|---|---|---|
| `--human-readable` | all `s3 ls` | Display-formatting flag with no `s3api` equivalent. Silently absorbing it would let an agent believe it received human-readable sizes when it did not. USAGE_ERROR is the honest choice. |
| `--summarize` | all `s3 ls` | Same — display-only, silent absorption misleads. |

**Full per-flag × per-path table for `s3 ls`:**

| Flag | No-URI path (`list-buckets`) | Prefix path (`list-objects-v2`) |
|---|---|---|
| `--recursive` | USAGE_ERROR (bucket listing has no recursion concept) | **Translate**: drops `--delimiter /` so all nested keys are returned, matching real `aws s3 ls --recursive` semantics. Not forwarded to `s3api`. |
| `--human-readable` | USAGE_ERROR (display-only; named exception) | USAGE_ERROR (display-only; named exception) |
| `--summarize` | USAGE_ERROR (display-only; named exception) | USAGE_ERROR (display-only; named exception) |
| `--page-size` | Forwarded verbatim | Forwarded verbatim (valid `list-objects-v2` flag) |
| `--request-payer` | USAGE_ERROR (`list-buckets` does not accept this param) | Forwarded verbatim (valid `list-objects-v2` flag) |
| `--bucket-name-prefix` | **Translate** to `--prefix` (the `list-buckets` param name) | USAGE_ERROR (this flag filters bucket names, not objects) |
| `--bucket-region` | Forwarded verbatim (valid `list-buckets` filter) | USAGE_ERROR (this flag filters the bucket list) |
| `--query` | **Cap bypassed**: `--max-items` is omitted from the child args when `--query` is active. JMESPath projects `NextToken` away; forwarding the cap would silently truncate the result at `S3_PAGE_SIZE` with no signal to the caller. Without `--max-items`, botocore auto-pages the complete result (same semantics as real `aws`). Curated projection skipped per the general `hasQuery` contract. | Same: cap bypassed, curated projection skipped. |
| `--starting-token` | Forwarded; `list-buckets` call capped at `S3_PAGE_SIZE` with `--max-items` (unless `--query` is also active — see row above). Truncation surfaces as a synthesized `NextToken` (botocore strips the native `ContinuationToken`; gating on it is dead code per `engine.ts` contract — issue #44). | Forwarded verbatim (valid `list-objects-v2` pagination flag) |

**`s3 ls` default delimiter behavior.** Real `aws s3 ls s3://b/` sends
`?delimiter=%2F`, grouping objects by common prefix ("folders"). Without
`--recursive`, `list-objects-v2` is called with `--delimiter /` and the response's
`CommonPrefixes` are surfaced as `prefixes[]` in the projection. With `--recursive`,
the delimiter is omitted and all nested keys are returned directly.

**`s3 head-object` flag guard:**

| Flag | Disposition |
|---|---|
| `--recursive` | USAGE_ERROR (`head-object` fetches a single key; recursion is not applicable) |
| All native `s3api head-object` flags | Forwarded verbatim |

This closes the scope boundary disclosed in PR #36 (issue #38). Where the invariant
does not hold (the two named exceptions above), the exception is deliberate and
documented here, not silently violated.

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

- **Unknown boolean flags followed by a bare positional** may still consume that
  positional as their value in the heuristic path. Two complementary mechanisms
  prevent this in practice: (1) model-based classification for service-model
  overlays (IAM, KMS, SSM, logs, lambda, secrets) — boolean flags known to
  botocore are classified correctly; (2) positional-stripping for S3 — positionals
  are removed before `collectPassthroughFlags` runs, so no bare token is ever
  adjacent to a passthrough flag.
- **Passthrough flags are forwarded but not exhaustively validated.** The model
  is used only for boolean/value classification; flags absent from the model are
  forwarded using the heuristic. An invalid flag name in passthrough causes the
  underlying `aws` invocation to fail with an error — the correct behavior (fail
  fast and loud, from the authoritative CLI).

- **Duplicate flags** (where the overlay adds a flag it also received via
  passthrough) are accepted; the `aws` CLI resolves them by using the last
  occurrence. This is intentional: server-side defaults set by the overlay can
  be overridden by an explicit passthrough value.
