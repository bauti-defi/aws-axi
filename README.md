<h1 align="center">aws-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/aws-axi"><img alt="npm" src="https://img.shields.io/npm/v/aws-axi?style=flat-square" /></a>
  <a href="https://github.com/bauti-defi/aws-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/bauti-defi/aws-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/bauti-defi/aws-axi/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/aws-axi?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square" /></a>
</p>

AWS CLI for agents — designed with [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface).

Wraps the official `aws` cli with token-efficient [TOON](https://toonformat.dev/) output, capped pagination
with honest totals, model-derived signatures instead of thousand-line help pages, structured errors, and
next-step suggestions. Built for autonomous agents that interact with AWS via shell execution. The AWS
analogue of [`gh-axi`](https://github.com/kunchenguid/gh-axi), built on
[`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js).

```
aws-axi <service> <operation> [--flags]   # mirrors: aws <service> <operation> [--flags]
```

> [!WARNING]
> **aws-axi is young.** Hand-polished overlays cover only the hot-path services; everything else runs
> through a generic engine that works but is less polished and may have bugs. **Secret values on the
> engine path are not redacted** (only the `ssm`/`secretsmanager` overlays redact). Use it carefully, and
> if it ever blocks you, fall back to raw `aws` for that call. **Found a bug or a gap? Please
> [file an issue](https://github.com/bauti-defi/aws-axi/issues/new)** — see [Reporting issues](#reporting-issues).

## Why

The `aws` CLI is built for humans at a terminal. For an LLM deciding the next command it is hostile:
verbose JSON, **auto-pagination that dumps multi-MB blobs in one call**, help pages thousands of lines
long, and errors buried in stderr. `aws-axi` keeps AWS's exact interface but changes the *output* and
*ergonomics* so an agent can act in one turn.

## How

Two layers over the real `aws` binary (we shell out to it — never reimplement AWS APIs):

- **A model-driven generic engine.** `aws-axi` reads the same [botocore](https://github.com/boto/botocore)
  service models the AWS CLI is generated from, so **every AWS operation works on day one** — with
  distilled signatures, required-param detection, capped pagination, and structured errors, auto-tracking
  each `aws` release.
- **Hand-polished overlays** for the highest-value services — curated schemas, idempotent mutations,
  secret redaction, and reference-resolution (show a security group's *name*, not `sg-…`). When an overlay
  doesn't implement an operation, it falls through to the generic engine automatically.

## Quick Start

No install needed — invoke on demand with [`npx`](https://docs.npmjs.com/cli/commands/npx):

```sh
npx -y aws-axi whoami
```

Requirements:

- The [`aws`](https://aws.amazon.com/cli/) CLI installed and configured (`aws sso login` or `aws configure`).
  aws-axi shells out to it.
- [Bun](https://bun.sh) (the CLI runs on the Bun runtime).

**Profile required on SSO-only setups.** `aws sso login --profile dev` never creates a
`[default]` section, so `~/.aws/config` may contain only named profiles with no default
fallback. aws-axi needs a profile, exactly as the raw `aws` CLI does. Three ways to supply it:

```sh
# 1. Per-command flag
npx -y aws-axi whoami --profile dev

# 2. Shell environment (standard; affects all AWS tools)
export AWS_PROFILE=dev && npx -y aws-axi whoami

# 3. aws-axi-specific env var (lowest precedence; pins a session without clobbering AWS_PROFILE)
export AWS_AXI_PROFILE=dev && npx -y aws-axi whoami
```

If aws-axi reports `NO_PROFILE_SELECTED`, it will list the available profiles — pick one from
that list and re-invoke.

For a global install and ambient session context:

```sh
bun add -g aws-axi        # or: npm install -g aws-axi
aws-axi setup hooks       # optional SessionStart hooks for Claude Code / Codex / OpenCode
aws-axi update --check    # check for a newer release; `aws-axi update` to upgrade
```

## Usage

```bash
aws-axi                         # dashboard — current identity + region, no args needed
aws-axi whoami                  # full identity: account, ARN, region, credential source
aws-axi ec2 describe-instances  # enriched overlay — instances with resolved names
aws-axi ec2 describe-regions    # not an overlay op → falls through to the generic engine
aws-axi s3 ls s3://my-bucket/prefix/
aws-axi logs tail /aws/lambda/my-fn --since 1h
aws-axi ssm get-parameter /my/app/db-password           # value redacted by default
aws-axi ssm get-parameter /my/app/db-password --reveal  # opt in to the plaintext value
aws-axi lambda invoke --function-name my-fn --payload '{"k":"v"}'
aws-axi wait ec2 instance-running --instance-ids i-0123456789abcdef0
aws-axi sqs list-queues         # no overlay → served entirely by the generic engine
aws-axi <service> <op> --help   # per-command signature + examples
```

Global flags `--profile <name>` and `--region <region>` are accepted before any command. Every response
ends with contextual `help:` next-step hints.

**Profile precedence** (highest to lowest):

| Source | Example |
|---|---|
| `--profile <name>` flag | `aws-axi whoami --profile dev` |
| `AWS_PROFILE` env var | `export AWS_PROFILE=dev` |
| `AWS_DEFAULT_PROFILE` env var | `export AWS_DEFAULT_PROFILE=dev` |
| `AWS_AXI_PROFILE` env var | `export AWS_AXI_PROFILE=dev` |

`AWS_AXI_PROFILE` is aws-axi-specific and has the lowest precedence. Use it to pin a
repository or agent session to a profile without clobbering the system-wide `AWS_PROFILE`
used by other tools.

## Capabilities

**What is implemented today.** Anything not listed as an enriched overlay still *works* through the
generic engine (correct, structured, capped) — it just isn't curated.

**Overlay superset invariant.** Every enriched overlay's input contract is a strict *superset* of the
real `aws` CLI's. Any flag the underlying `aws` operation accepts is forwarded verbatim to the child
`aws` invocation. The overlay changes the *output*, never restricts the *input*. Two flags are handled
specially: `--output` is stripped (the exec seam always appends `--output json`); `--query` is
forwarded verbatim, bypasses the overlay's curated projection (result shape is unknown), and
suppresses the overlay's default `--max-items` cap (JMESPath projects `NextToken` away, so
botocore auto-pages to the complete result without a cap). An explicit `--max-items` you supply
yourself is still honored. These two bypass behaviors apply to **all** enriched overlays and the
generic engine. Two deliberate named exceptions exist for `s3 ls` (see below).

> **S3 `ls` flag handling.** `s3 ls` rewrites to `s3api` internally. Dispositions per flag × path:
>
> | Flag | No URI (list-buckets) | With URI (list-objects-v2) |
> |---|---|---|
> | `--recursive` | USAGE_ERROR | **Translated**: drops `--delimiter /`, returning all nested keys |
> | `--human-readable` | USAGE_ERROR | USAGE_ERROR *(named exception: display-only; silent absorb would mislead)* |
> | `--summarize` | USAGE_ERROR | USAGE_ERROR *(named exception: same reason)* |
> | `--page-size` | forwarded | forwarded |
> | `--request-payer` | USAGE_ERROR (invalid for list-buckets) | forwarded |
> | `--bucket-name-prefix` | **Translated** to `--prefix` | USAGE_ERROR |
> | `--bucket-region` | forwarded | USAGE_ERROR |
> | `--query` | **Cap bypassed** (JMESPath projects `NextToken` away; botocore auto-pages complete result); curated projection skipped | Same: cap bypassed, curated projection skipped |
> | `--starting-token` | forwarded; `list-buckets` capped at `S3_PAGE_SIZE` — truncation reported via synthesized `NextToken` (not native `ContinuationToken`, which botocore strips) | forwarded |
>
> Default: `s3 ls s3://b/` adds `--delimiter /` (matching real `aws s3 ls` behavior) and surfaces
> `CommonPrefixes` as `prefixes[]`. Folder-only buckets are never reported as empty.
>
> `s3 cp` and `s3 rm` use the high-level `aws s3` commands, so `--recursive`, `--exclude`,
> `--include`, `--sse`, and `--storage-class` are valid passthrough for those.

| Service          | Command            | Enriched overlay operations                                                                  | Everything else                    |
| ---------------- | ------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| STS              | `whoami`           | identity fused with profile, region, credential source                                       | —                                  |
| EC2              | `ec2`              | `describe-vpcs`, `describe-subnets`, `describe-security-groups`, `describe-instances`         | → generic engine                   |
| S3               | `s3`               | `ls`, `cp`, `rm`, `head-object`, `create-bucket` (idempotent)                                | → generic engine                   |
| IAM              | `iam`              | `list-roles`, `get-role`, `list-policies`, `get-policy`, `list-attached-role-policies`       | → generic engine                   |
| CloudWatch Logs  | `logs`             | `tail`, `filter`, `describe-log-groups`                                                       | → generic engine                   |
| KMS              | `kms`              | `list-keys`, `list-aliases`, `describe-key`, `get-key-policy`                                 | → generic engine                   |
| Lambda           | `lambda`           | `list-functions`, `get-function`, `get-function-configuration`, `invoke`                      | → generic engine                   |
| SSM              | `ssm`              | **`run`** (send+wait+unescaped output in one call), **`get-command-invocation`** (unescaped, `--wait`), `describe-parameters`, `get-parameter`, `get-parameters`, `get-parameters-by-path` (redacted) | → generic engine                   |
| Secrets Manager  | `secretsmanager` (alias `secrets`) | `list-secrets`, `get-secret-value` (redacted), `describe-secret`             | → generic engine                   |
| Waiters          | `wait`             | any botocore waiter, e.g. `wait ec2 instance-running`, `wait s3 bucket-exists`                | —                                  |
| **Any other service** | *(service name)* | —                                                                                        | **fully served by the generic engine** |

Plus: `setup hooks` (ambient SessionStart context) and the SDK built-in `update` / `update --check`.

**Generic engine coverage.** `aws-axi <service> <operation>` works for any service/operation in your
installed `aws` CLI's botocore models — required-param validation, capped pagination, and structured
errors, but a generic projection (no reference-name enrichment, no idempotency niceties, **no secret
redaction**).

**Not implemented yet / known limitations:**

- **No redaction on the engine path.** Only the `ssm` and `secretsmanager` overlays redact secret values.
  Reading a secret via the raw engine (e.g. some other service's secret-bearing field) prints it in the clear.
- **Mutations are mostly raw.** Idempotency / `--dryrun` niceties exist only for the S3 overlay
  (`cp`, `rm`, `create-bucket`); other writes go through the engine unguarded.
- **`logs tail` is a snapshot, not a live follow** (`aws logs tail --follow` has no equivalent).
- **Overlays are read-heavy.** Most curated commands are describes/gets; write-path overlays are minimal.
- **Runtime is Bun** (not Node) and there is no Windows build.

## `aws` ↔ `aws-axi`

The interface mirrors the AWS CLI 1:1 — same service and operation names — so most commands are identical
apart from the `aws-axi` prefix. **aws-axi needs a profile for exactly the same reason raw `aws` does.**
If you habitually `export AWS_PROFILE=dev` and never notice, raw `aws` works fine for the same reason
`aws-axi` works fine — both see the env var. (This was the source of #70's confusion: "the raw CLI
works fine for me" was really "I export `AWS_PROFILE` and never noticed.")

Where the ergonomics differ, here is the map both ways:

| You'd run with `aws`                                   | With `aws-axi`                                         | What changed                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `aws ec2 describe-instances --output json`             | `aws-axi ec2 describe-instances`                       | Output is always TOON; `--output` is ignored (stripped)                     |
| `aws ec2 describe-instances --filters Name=...,Values=...` | `aws-axi ec2 describe-instances --filters Name=...,Values=...` | `--filters` (and any other aws flag) forwarded verbatim; output is still enriched TOON |
| `aws iam list-roles --query 'Roles[].RoleName'`        | `aws-axi iam list-roles --query 'Roles[].RoleName'`   | `--query` forwarded; JMESPath applied by aws CLI; overlay projection bypassed |
| `aws sts get-caller-identity`                          | `aws-axi whoami`                                       | Fused with profile, region, and credential source                          |
| *(no equivalent)*                                      | `aws-axi`                                              | No-arg dashboard: current identity + region                                |
| `aws s3 ls s3://bucket/`                               | `aws-axi s3 ls s3://bucket/`                           | Same; `--delimiter /` added (matches real non-recursive behavior); output capped + TOON (use `--starting-token` to page; `--query` bypasses cap) |
| `aws s3 ls s3://bucket/ --recursive`                   | `aws-axi s3 ls s3://bucket/ --recursive`               | `--recursive` translated: drops `--delimiter /` so all nested keys are returned |
| `aws s3 ls s3://bucket/ --page-size 5`                 | `aws-axi s3 ls s3://bucket/ --page-size 5`             | `--page-size` forwarded verbatim to `s3api list-objects-v2`                |
| `aws s3 ls s3://bucket/ --human-readable`              | `aws-axi s3 ls s3://bucket/` (drop the flag)           | `--human-readable` → clean USAGE_ERROR (named exception; silent absorb misleads) |
| `aws s3 ls --bucket-name-prefix foo`                   | `aws-axi s3 ls --bucket-name-prefix foo`               | `--bucket-name-prefix` translated to `--prefix` on `list-buckets`          |
| `aws s3api list-buckets`                               | `aws-axi s3 ls`                                        | High-level `s3 ls` with no target lists buckets; output capped at 20 + TOON (use `--starting-token` to page; `--query` bypasses cap) |
| `aws s3api list-buckets --starting-token TOK`          | `aws-axi s3 ls --starting-token TOK`                   | `--starting-token` forwarded on both paths (`list-buckets` is genuinely paginated); output capped + TOON |
| `aws logs tail <group> --since 1h`                     | `aws-axi logs tail <group> --since 1h`                | Same flag; snapshot (no `--follow`), capped with `--limit`                  |
| `aws logs filter-log-events --log-group-name <g> --filter-pattern ERROR` | `aws-axi logs filter <g> ERROR`     | Positional group + pattern                                                  |
| `aws ssm send-command … && sleep 12 && aws ssm get-command-invocation …` | `aws-axi ssm run --instance-ids i-… --commands "docker ps"` | One call: sends, polls, returns unescaped stdout/stderr/remoteExitCode. Exit codes: remote shell exit propagated verbatim (1..249); delivery failure (TimedOut/Undeliverable/Cancelled) → 254; InProgress → 0 (no false failure for polling loops); `--query` → USAGE_ERROR (no single underlying response to target — use `get-command-invocation --query` instead) |
| `aws ssm get-command-invocation --command-id … --instance-id …` (output has `\n`-escaped blobs) | `aws-axi ssm get-command-invocation --command-id … --instance-id … [--wait]` | `--wait` polls until terminal; stdout/stderr rendered as line arrays (unescaped) |
| `aws ssm get-parameter --name <n> --with-decryption`   | `aws-axi ssm get-parameter <n> --reveal`              | Redacted by default; `--reveal` opts in (adds `--with-decryption`)         |
| `aws secretsmanager get-secret-value --secret-id <id>` | `aws-axi secretsmanager get-secret-value <id> --reveal` | Redacted by default; `--reveal` opts in                                   |
| `aws kms describe-key --key-id alias/foo`              | `aws-axi kms describe-key alias/foo`                   | Positional id; accepts id, ARN, or alias                                    |
| `aws lambda invoke --function-name f --payload '<json>' --cli-binary-format raw-in-base64-out out.json` | `aws-axi lambda invoke --function-name f --payload '<json>'` | `--cli-binary-format` handled automatically; result returned inline |
| `aws ec2 wait instance-running --instance-ids i-…`     | `aws-axi wait ec2 instance-running --instance-ids i-…`| `wait` is a top-level verb; waiter names stay kebab-case; adds a polling budget |
| `aws <svc> <op> ...` (auto-paginates everything)       | `aws-axi <svc> <op> --max-items N --next-token <tok>` | Capped by default with an honest `count`; resume with the emitted token    |
| `aws` never reads `.env` from cwd                      | installed `aws-axi` never reads `.env` from cwd       | The distributed launcher honors only exported shell env vars and `~/.aws/*`; a repo's `.env` (e.g. `AWS_ENDPOINT_URL=http://localhost:4566` for LocalStack) is ignored |

**Conventions that apply everywhere:**

- **Output** — TOON, not JSON. Tabular result sets render as `key[N]{col,col}` blocks with a `count`.
- **Pagination** — capped by default (`--max-items` / `--limit`, service-specific defaults). When more
  exists, the result carries a `NextToken`; resume with `--next-token` (or `--starting-token` for `s3 ls`).
- **Errors** — structured TOON on stderr (`error`, `code`, `help[]`) with exit codes:

  | Code | Exit | Meaning |
  |---|---|---|
  | `USAGE_ERROR` | 252 | Bad flag or argument |
  | `NO_CREDENTIALS` | 253 | No AWS credentials found — run `aws sso login` |
  | `NO_PROFILE_SELECTED` | 253 | Named profiles exist but none was selected — pass `--profile <name>` or `export AWS_PROFILE=<name>`; **not** an auth failure |
  | `AUTH_EXPIRED` | 253 | Profile exists but SSO token stale — run `aws sso login --profile <name>` |
  | `SERVICE_CLIENT_ERROR` | 254 | AWS service or client error |
  | `AWS_NOT_INSTALLED` | 127 | `aws` binary not found in PATH |
  | `DRY_RUN_SUCCESS` | 0 | `DryRunOperation` success signal (not an error) |
  | `UNKNOWN` | 255 | General / unrecognized error |
- **Redaction** — `ssm` and `secretsmanager` overlays redact values unless `--reveal` is passed.
- **Idempotency** — overlay mutations (e.g. `s3 create-bucket`) report what changed and are safe to re-run.
- **No `.env` loading (installed CLI)** — the distributed launcher never reads `.env` from the current
  directory. Only genuinely-exported shell environment variables and `~/.aws/*` config are honored,
  matching the `aws` CLI exactly. (If you run `bun run bin/aws-axi.ts` directly in a repo that has a
  `.env`, use `bun --no-env-file bin/aws-axi.ts` to get the same isolation.)
- **Overlay superset** — any flag the underlying `aws` operation accepts is forwarded verbatim. Overlays
  change the output, never restrict the input. Exception: `--output` is stripped (always `json` internally);
  `--query` is forwarded verbatim, bypasses the overlay's curated projection, and suppresses the
  default `--max-items` cap (botocore auto-pages to completion; explicit `--max-items` still wins).

## Reporting issues

aws-axi is early and improving. If you hit a bug, wrong output, or a missing capability, please file an
issue at [`bauti-defi/aws-axi`](https://github.com/bauti-defi/aws-axi/issues) — include the `aws-axi`
command you ran, what you expected, what you got, and the equivalent raw `aws` command. If you use
[`gh-axi`](https://github.com/kunchenguid/gh-axi):

```sh
gh-axi issue create --title "..." --label bug --body "..."
```

## Development

```sh
bun install
bun run dev          # run the CLI directly (bun run bin/aws-axi.ts …)
bun test             # run the test suite
bun run typecheck    # tsc --noEmit
bun run check:pins   # enforce exact-pinned dependencies
bun run build        # bundle to dist/bin/aws-axi.js
bun run build:skill  # regenerate skills/aws-axi/SKILL.md (CI fails if it drifts)
bun run verify:dist  # pre-publish guard
bun run release      # build → verify:dist → test → npm publish (bump version first)
```

The committed `skills/aws-axi/SKILL.md` is generated by `bun run build:skill`; CI fails if it drifts. The
npm package ships `skills/aws-axi/`, so published releases include the installable Agent Skill.

## License

[MIT](LICENSE)
