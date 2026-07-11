# aws-axi — Design Spec

> **Status:** Draft (design approved, pre-implementation) · **Date:** 2026-07-11 · **Owner:** bauti.eth
>
> A general-purpose, agent-ergonomic wrapper over the `aws` CLI. The AWS analogue of
> [`gh-axi`](https://github.com/kunchenguid/gh-axi) — built on
> [`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) + [TOON](https://toonformat.dev/),
> following the [AXI standard](https://github.com/kunchenguid/axi).

## 1. Summary

Autonomous agents drive AWS through the `aws` CLI, but that CLI is built for humans at a
terminal: verbose JSON, auto-pagination that dumps multi-MB blobs in a single call, help
pages thousands of lines long, and error text buried in stderr. `aws-axi` wraps `aws` and
re-presents it for an LLM deciding the next command — token-efficient TOON output, capped
pagination with honest totals, distilled model-derived signatures instead of 5,000-line
help, structured errors, and next-step suggestions.

It is **general-purpose and vendor-neutral**: it wraps the public `aws` CLI for anyone. It
is not shaped around any one organization's usage. (DAMM Capital's heavy AWS usage is used
only as a *dogfooding target* to exercise and harden the tool, never as a spec.)

## 2. Goals & non-goals

**Goals**

- Wrap the `aws` CLI 1:1 and make its output agent-ergonomic (the AXI 10 principles).
- **Full coverage on day one**: every one of the ~18k `aws` operations works through a
  generic, model-driven engine — not just hand-modeled commands.
- **Hand-polish the hot path**: curated schemas, aggregates, idempotent mutations,
  reference-resolution, and suggestions for the highest-value, most foundational services.
- Fast cold-start (agents invoke the CLI once per command).

**Non-goals**

- Not a new command vocabulary or an opinionated deploy/provisioning assistant. We mirror
  `aws`, we do not replace it.
- Not an SDK/API reimplementation. We shell out to the real `aws` binary (like `gh-axi`
  shells out to `gh`) — never reimplement AWS APIs.
- No organization-specific commands, conventions, account IDs, tags, or profiles.

## 3. Core principle — mirror the AWS CLI

**`aws-axi <service> <operation> [--flags]` mirrors `aws <service> <operation> [--flags]`
as closely as possible.** Same service names, same operation names, same flag names.
`aws-axi` is a transparent, agent-friendly *skin* over `aws`; an agent (or human) who knows
`aws` already knows `aws-axi`. We change the *output* (TOON, curated, capped) and the
*ergonomics* (structured errors, suggestions, whoami, idempotent no-ops), not the interface.

Consequences:

- Hand-polished commands keep AWS's real operation names (`describe-instances`, not a
  renamed `list`). Where AWS itself offers a friendlier face (S3's `s3 ls/cp/rm` over
  `s3api`), we mirror both faces as AWS presents them.
- Unknown/unmodeled operations fall through to the generic engine rather than erroring —
  the interface is as wide as `aws` itself.
- Global flags an agent expects from `aws` (`--profile`, `--region`, `--output`, `--query`)
  are honored/passed through; `--output` lets a caller opt back into raw `json`/`table`.

## 4. Architecture

Two layers over one exec seam, all on the `axi-sdk-js` kernel. Runtime is **Bun** (fast
cold-start; DAMM's default runtime). `axi-sdk-js` and `@toon-format/toon` are consumed as
ordinary, exact-pinned npm dependencies.

### 4.1 Layer 1 — the model-driven generic engine (the differentiator)

The AWS CLI is auto-generated from **botocore service models**: readable JSON shipped inside
the installed `aws` v2 bundle at
`…/awscli/botocore/data/<service>/<api-version>/service-2.json` (+ `paginators-1.json`,
`waiters-2.json`). `aws-axi` reads those *same* models. For **any** of the ~18k operations
this yields, with zero hand-coding:

- **Required params** — from each operation's input-shape `required[]`.
- **The error set** — from each operation's `errors[]`.
- **The list field** — from `paginators-1.json` `result_key` (which output field is "the
  list"), so we can cap and count it honestly.
- **Wait-flows** — from `waiters-2.json` (`delay`/`maxAttempts`/`acceptors`), exposed as a
  first-class `wait` primitive.
- **Distilled signatures** — a compact, model-derived replacement for `aws … help` (whose
  raw form runs to thousands of lines).

So `aws-axi <service> <op> [--flags]` works across all of AWS on day one: it shells to
`aws … --output json`, caps auto-pagination, projects to TOON, strips envelope noise
(`ResponseMetadata`), and maps errors — for operations no human ever modeled. Because the
engine reads the local models, it **auto-tracks each `aws` CLI release** with no code
change. This is the deep module the whole design hinges on.

### 4.2 Layer 2 — hand-polished overlays for the hot path

On top of the engine, curated commands for the first-wave services apply the AXI principles
the generic engine can only approximate: minimal default schemas (the 3–4 load-bearing
fields), pre-computed aggregates, idempotent-mutation mapping, secret redaction, and
next-step suggestions. Critically, they **enrich raw references** the generic engine leaves
opaque — showing a security group's *name* and a task role's *name*, not `sg-…`/an ARN — by
calling shared resolve-primitives.

### 4.3 Shared resolve-primitives (built once at the roots, reused upward)

Every AWS create/describe path fans into the same handful of foundational references. Build
each primitive once at the root service; higher-tier commands consume it to enrich output:

| Primitive | Backed by | Consumed by |
|---|---|---|
| `resolve-identity` | STS `get-caller-identity` (+ profile/region/cred-source) | **every** command (the whoami gate) |
| `resolve-role` / `resolve-policy` | IAM `get-role` / `list-*` | ecs (`taskRoleArn`,`executionRoleArn`), lambda (`Role`), eks (`roleArn`), ec2 (`IamInstanceProfile`), rds (`MonitoringRoleArn`) |
| `resolve-vpc/subnet/sg` | EC2 `describe-subnets`/`-security-groups`/`-vpcs` | ecs (`awsvpcConfiguration`), lambda (`VpcConfig`), eks (`resourcesVpcConfig`), rds (`DBSubnetGroupName`,`VpcSecurityGroupIds`), ec2 run-instances |
| `resolve-log-group` | CW Logs `describe-log-groups` | ecs (`logConfiguration`), lambda (`LoggingConfig.LogGroup`), eks (`logging`); read side of every "tail this compute's logs" flow |
| `resolve-key` | KMS `describe-key`/`list-aliases` | lambda (`KMSKeyArn`), rds (`KmsKeyId`), dynamodb (`KMSMasterKeyId`), secretsmanager (`KmsKeyId`), ssm (`KeyId`) |
| `resolve-bucket` | S3 `head-bucket`/`list-buckets` | cloudformation templates, lambda deploy packages, artifact flows |

### 4.4 Reused from `axi-sdk-js` as-is

`runAxiCli` dispatch, `--help`/`-v`/`update` (self-update), SessionStart hooks (via a
user-invoked `setup` command), `AxiError` + exit codes, TOON `renderOutput`. Structurally
we copy `gh-axi`'s file layout and swap the domain seam: `gh.ts → aws.ts`,
`RepoContext → AwsContext` (profile/region), and rewrite `errors.ts` for the botocore error
taxonomy. The `com.axi-tools.autoupdate` launchd loop gains an `aws-axi` entry.

## 5. Core modules (deep, independently testable)

1. **`model.ts`** — botocore reader: locate the `aws` bundle, parse a service model →
   `{ operation, required[], errors[], listKey, waiters }`. Pure, cache-backed. *Keystone.*
2. **`aws.ts`** — exec seam: `execFile("aws", […args, "--output", "json"])`, appends
   resolved `--profile`/`--region`; `awsJson` / `awsExec` / `awsRaw`.
3. **`project.ts`** — JSON→TOON projection + a `FieldDef`/`extract` layer (ported from
   `gh-axi/src/toon.ts`). We parse full JSON ourselves and project — we do **not** delegate
   shaping to `--query`, because we need the pre-projection totals/pagination metadata for
   honest truncation reporting.
4. **`paginate.ts`** — cap auto-pagination; emit `count: N of M total; next-token=…` using
   the model's `result_key`/`output_token`.
5. **`errors.ts`** — parse `An error occurred (<Code>) …` (stderr) → typed `AxiError`.
6. **`resolve/*`** — the six primitives in §4.3.
7. **`commands/*`** — `home`, `setup`, `whoami`, plus the first-wave nouns.

## 6. Output & ergonomics conventions

- **TOON at the boundary; JSON internally.** ~40% token savings.
- **`whoami` as a fused primitive.** No single `aws` command answers "who/where am I":
  fuse `sts get-caller-identity` with the resolved profile, region, and credential source,
  and detect the `ExpiredToken`/no-credentials states with an actionable "run
  `aws sso login`" hint. Likely the #1 agent primitive.
- **Cap auto-pagination, report honest totals.** `aws` fetches *all* pages by default. We
  default to a bounded page and report `count: N of M total; next-token=…` rather than
  dumping everything. This is the single biggest token-safety feature.
- **Curated schemas over huge describe/list trees.** Project hot ops to the load-bearing
  fields; offer `--fields` to opt into more and `--full` for the untruncated blob.
- **Structured errors on stdout.** Map the botocore code to a category with an actionable,
  own-CLI suggestion. Categories: auth-expired · no-credentials · forbidden (surface the
  missing IAM action) · throttled (auto-retry with backoff) · not-found · validation ·
  `DryRunOperation` = **success** signal.
- **Idempotent mutations.** Map "already in desired state" → success no-op:
  `BucketAlreadyOwnedByYou`, `EntityAlreadyExists` (IAM), `ResourceAlreadyExistsException`
  (logs), tag-already-present.
- **`--dry-run` as a safe permission-preview.** EC2's `DryRunOperation` /
  `UnauthorizedOperation` pattern → "would this succeed / do I have permission?" without
  mutating.
- **`wait` as a first-class primitive** — backed by `waiters-2.json`, with a bounded,
  reported timeout instead of hand-rolled poll loops.
- **Definitive empty states**, **content-first home view**, **next-step suggestions**, and
  **`bin:`/`description:` header** per the AXI standard.

## 7. Service dependency hierarchy & build order

The primary prioritization key. Tiers are grounded in the botocore input/output shapes: a
service sits higher when its request shapes carry ID references to lower-tier resources.
(Verified members, e.g. `AwsVpcConfiguration.{subnets,securityGroups}`,
`CreateFunctionRequest.{Role,VpcConfig,KMSKeyArn,LoggingConfig.LogGroup}`,
`CreateDBInstanceMessage.{DBSubnetGroupName,VpcSecurityGroupIds,KmsKeyId}`.)

```
TIER 0 — ROOTS      STS · IAM · EC2-networking (VPC/subnet/SG) · CloudWatch Logs · S3 · KMS
                      │  (their IDs/ARNs are INPUT members of ↓)
TIER 1 — COMPUTE/DATA EC2 instances · ECS · EKS · Lambda · RDS · DynamoDB
                      │  (referenced by ↓)
TIER 2 — ORCH/CONFIG  CloudFormation · SecretsManager · SSM · EventBridge/Scheduler · SQS/SNS
```

Note: **EC2 is split** — its *networking* resources are Tier 0 (consumed by
ECS/EKS/Lambda/RDS alike); `run-instances` is Tier 1. Treat them as separate build units.

**Root-first build order** (each service leans on primitives already built):

- **Phase A — Tier-0 roots + primitives:**
  1. **STS / `whoami`** → `resolve-identity` (the anchor; #1 primitive).
  2. **IAM** (list/get) → `resolve-role`/`resolve-policy`. *Raised early — highest fan-out.*
  3. **EC2-networking** (`describe-subnets`/`-security-groups`/`-vpcs`) → `resolve-vpc/subnet/sg`.
  4. **CloudWatch Logs** (`describe-log-groups`, `tail`, `filter-log-events`) → `resolve-log-group`.
  5. **S3** (`ls`/`cp`/`rm`/`list-buckets`/`head-object`) → `resolve-bucket`.
  6. **KMS** (`describe-key`/`list-aliases`) → `resolve-key`.
- **Phase B — Tier-1 compute/data:** EC2 instances (`describe-instances`, enriched) →
  **Lambda** → ECS → EKS/RDS/DynamoDB as demand dictates.
- **Phase C — orchestration/config:** **SSM Parameter Store + Secrets Manager** (get/list,
  redacted) → CloudFormation, EventBridge/Scheduler, SQS/SNS.

**Secondary key — dogfooding.** Among services at a tier, prefer those the dogfooding
target exercises so the tool is battle-tested as it grows. Read-only slices of Lambda, SSM,
and Secrets depend only on Logs/KMS for enrichment and may be pulled forward once their
roots exist (rather than waiting for the full tier). Deep mutating paths stay in strict tier
order, where reference-resolution correctness matters.

## 8. First-wave scope (v1)

The generic engine ships first (full coverage). Then hand-polished commands, in build order:
`whoami` · IAM (read) · EC2-networking (read) · CloudWatch Logs · S3 · KMS · EC2 instances ·
Lambda · SSM Parameter Store + Secrets Manager (read, redacted). Everything else is served
by the generic engine until promoted.

## 9. Testing strategy

- **`bun test`**, colocated per module (mirrors `gh-axi`'s Vitest layout, on Bun).
- Test **external behavior**, not internals. The deep modules are the priority targets:
  - `model.ts` — parse fixture `service-2.json`/`paginators-1.json`/`waiters-2.json`
    snapshots → assert required params, error sets, list keys, waiters. Pin fixtures so the
    test is deterministic across aws-cli versions.
  - `project.ts` — JSON→TOON projection golden tests.
  - `paginate.ts` — cap + honest-total reporting on multi-page fixtures.
  - `errors.ts` — real `aws` stderr strings → correct category + exit code.
- **Real boundaries, not mocks.** The exec seam is tested against recorded `aws` outputs;
  no mock AWS client. (LocalStack is a candidate for a later integration tier.)
- **Skill drift gate** — a `--check` step fails CI if `SKILL.md` diverges from the home view.

## 10. Packaging & distribution

- **Runtime: Bun** (primary). Dev/test via `bun test`. The bin's distribution runtime
  (bun-required bin vs. a node-compatible build vs. `bun build --compile` standalone
  binaries for Homebrew) is resolved in the packaging slice; npm remains the baseline
  channel so `axi-sdk-js`'s `update` self-upgrade and the `com.axi-tools.autoupdate` loop
  work unchanged.
- **Exact-pinned deps** (`axi-sdk-js`, `@toon-format/toon`) — no `^`/`~`.
- **Skill** generated from the home view (single source of truth) with a CI drift check.
- **Release** via release-please + OIDC `npm publish --provenance` (no static token).
- **Ambient context** via `aws-axi setup` (SessionStart hooks for Claude Code / Codex /
  OpenCode) — the home view surfaces current identity/region as ambient context.

## 11. Out of scope for v1

- Hand-modeling beyond the first wave — the generic engine covers the long tail.
- **Stateful SSM interactive sessions / port-forward tunnels** — the one genuinely stateful
  surface (a `chrome-devtools-axi`-style daemon lifecycle); deserves its own later slice.
- Any organization-specific commands, tags, account IDs, or profiles.

## 12. Open questions

1. **Distribution runtime** — bun-required bin, node-compat build, or `bun build --compile`
   standalone binaries (+ Homebrew tap)? Resolved in the packaging slice.
2. **Catalog name** — the axi *community catalog* lists an unrelated 1-commit
   `aws-axi` (thatdudealso); npm `aws-axi` is free and we ship under it. Coordinate the
   catalog label later if desired; not a blocker.
3. **Model-location robustness** — the botocore data path differs across install methods
   (Homebrew, the official `.pkg` bundle, `pipx`). `model.ts` must probe candidate paths and
   fail loudly with a clear message if it can't find the models.

## Appendix — key evidence

- Botocore models: `/usr/local/aws-cli/awscli/botocore/data/<service>/<version>/service-2.json`
  (414 services, ~18k operations; `paginators-1.json` on 412, `waiters-2.json` on 147). All
  world-readable JSON. Verified on aws-cli 2.33.13.
- Error surfacing: service errors on **stderr** as `An error occurred (<Code>) when calling
  the <Op> operation: <message>`. Exit codes: 252 usage · 253 no-credentials · 254
  service-client-error · 255 general.
- Auto-pagination is **ON by default** (`aws` concatenates all pages) — the primary
  token hazard the wrapper must cap.
