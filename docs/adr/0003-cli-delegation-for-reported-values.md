# ADR-0003: CLI delegation for all values aws-axi reports as fact

**Status:** Accepted
**Date:** 2026-07-23
**PR:** #71 (cycle 3)

## Context

aws-axi reads `~/.aws/config` locally in one place: `readAwsConfigProfiles`, which discovers
named profile names so that a `NO_PROFILE_SELECTED` error can list them. That is the correct
and intended use — diagnostics, never decision-making.

During #71 (cycle 2), `readConfigProfileRegion` was added to supply the `region` field in
`whoami` output without a second subprocess. The function was a hand-rolled INI parser that
read only `~/.aws/config` and matched section headers with exact string comparison.

The apparent motivation was performance: `aws configure get region` ≈ 0.41s (Python CLI
startup), and `whoami` was already paying ~1.92s for `sts get-caller-identity`. Replacing the
subprocess with a file read appeared to save that 0.41s.

## Evidence that the parser was wrong

Six independently measured divergences from `aws-cli/2.33.13` (ground truth = `aws configure
get region` / `aws configure list`):

| Config shape | real `aws configure get region` | INI parser |
|---|---|---|
| `region` in `~/.aws/credentials`, different value in `~/.aws/config` | credentials-file value | config-file value (**wrong value**) |
| `region` only in `~/.aws/credentials` | correct region | `undefined` → `"unknown"` |
| `[profile default]` alias for `[default]` | correct region | `undefined` → `"unknown"` |
| `Region = …` (capital key; botocore lowercases) | correct region | `undefined` → `"unknown"` |
| `[profile  spaced]` (two spaces before name) | correct region | `undefined` → `"unknown"` |
| `[profile inline] # trailing comment` | correct region | `undefined` → `"unknown"` |

End-to-end reproduction of the wrong-value case with live SSO credentials:

```
# ~/.aws/config:       [profile dev] ... region = us-west-2
# ~/.aws/credentials:  [dev]          ... region = eu-central-1

$ aws configure get region --profile dev
eu-central-1                        ← credentials-file wins

$ aws configure list --profile dev | grep region
region : eu-central-1 : config-file : .../live_cfg

$ aws-axi whoami --profile dev      ← at 18acb3c, with INI parser
  region: us-west-2                 ← WRONG
```

Five of the six divergences are a re-creation of #70 secondary bug 1 — "`region: unknown` even
when the profile configures one" — for config shapes the INI parser could not parse.

## Evidence that the perf tradeoff dissolved

Measured on the same machine, 5 runs each, warm SSO cache:

| Path | median wall time |
|---|---|
| `aws configure get region` alone | **0.41s** |
| `aws sts get-caller-identity` alone | 1.92s |
| sequential (what the cycle-2 INI fix replaced) | 2.21s |
| **concurrent** (this ADR's decision) | **1.56s** |

Running `aws configure get region` **concurrently with** `sts get-caller-identity` via
`Promise.all` recovers the entire sequential saving. The region call's 0.41s hides inside the
STS round-trip. Net cost of correct delegation: zero.

## Decision

**Credential and configuration *resolution* stays delegated to the `aws` CLI. Any value
aws-axi reports as fact about the session must come from the CLI, or from what aws-axi itself
injected — never from an independent re-parse of AWS config files.**

Local parsing of `~/.aws/config` is permitted **only** for diagnostics: naming profiles in a
`NO_PROFILE_SELECTED` error message. It must never back a field that `whoami` (or any other
command) reports as a fact about the running session.

Corollary: **aws-axi must not accept input the raw `aws` CLI would reject.** A concrete
instance: `nonEmpty()` was trimming padded env vars (`" dev "` → `"dev"`), making
`AWS_PROFILE=" dev "` succeed under aws-axi while the real CLI rejects it with
"The config profile ( dev ) could not be found". aws-axi must produce the same failure.

Implementation (`src/commands/whoami.ts`):
- Remove `readConfigProfileRegion` and its caller `getProfileRegion`.
- Add `awsConfigureGetRegion`: a thin wrapper around `awsRaw(["configure", "get", "region"])`.
  Returns `undefined` on any failure; never throws.
- Launch `awsConfigureGetRegion` concurrently with `awsJson(["sts", "get-caller-identity"])`
  via `Promise.all`. Guard: skip the concurrent launch when the region is already known from
  `context.region` / `AWS_REGION` / `AWS_DEFAULT_REGION` — the common agent case.
- The region promise is wrapped in `.catch(() => undefined)` so a region failure can never
  mask a STS error.

## Rationale

- **A second parser is a second source of truth and will drift.** The six divergences above
  are structural, not bugs that can be patched — `~/.aws/credentials` file-set merging,
  configparser lowercasing, header whitespace normalization, and inline-comment stripping are
  all botocore implementation details that a hand-rolled parser cannot track reliably.
- **The perf argument is factually wrong.** The concurrent path costs nothing over the STS
  baseline. There is no tradeoff to accept.
- **Blast radius is high.** `whoami` is the documented #1 agent primitive. `region` is the
  field an agent reads to decide which `--region` to pass downstream. A wrong region sends
  subsequent calls to the wrong regional endpoint — silent empty result sets, silent wrong
  conclusions. A wrong value reported with confidence is strictly worse than `"unknown"`.

## Accepted tradeoffs

None. The concurrent approach is both correct and fast. The only thing removed is the
(wrong) parser and the code path that called it.

## Consequences

- `readConfigProfileRegion` is dead code and is removed in this PR. `readAwsConfigProfiles`
  is retained for the diagnostics path (`enrichNoCredsError`).
- Any future contributor who wants to "optimize" region resolution by reading config files
  directly should read this ADR first and re-run the six divergence cases above.
- `docs/specs/2026-07-11-aws-axi-design.md` has no claims about INI parsing for resolution
  (it predates the parser); no update needed there.
