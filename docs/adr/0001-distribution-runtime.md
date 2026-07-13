# ADR-0001: Distribution runtime — Bun-native build, manual npm release

**Status:** Accepted  
**Date:** 2026-07-13  
**Slice:** #15 (Packaging & release)

## Context

The spec (§10, open question #1) left the distribution runtime open, and open question #2 left the release automation strategy open:

| Option | Mechanism | Runtime dep | Reach |
|---|---|---|---|
| **(a) bun-required bin** | `bun build` bundles to `dist/bin/aws-axi.js`; `#!/usr/bin/env bun`; published to npm | Bun | AXI toolchain |
| **(b) node-compatible build** | `tsc` → `dist/bin/aws-axi.js`; `#!/usr/bin/env node`; published to npm | Node ≥ 20 | Wide |
| **(c) bun compile standalone** | `bun build --compile`; per-platform binaries; Homebrew tap | None | Widest, heaviest |

Release automation options:
| Option | Mechanism | Who triggers |
|---|---|---|
| **(x) Manual local release** | `bun run release` → build → verify → test → `npm publish`; human bumps version | Human operator |
| **(y) release-please + OIDC** | GH Actions watches `main`; release-please PR; OIDC provenance on publish | CI/CD bot |

## Decision

**Option (a): Bun-native build + option (x): manual local release.**

`bun build ./bin/aws-axi.ts --outdir ./dist/bin --target bun --packages external`
bundles the first-party source into a single `dist/bin/aws-axi.js` (runtime deps stay
in `node_modules`, installed by the consumer via npm). The entry shebang is
`#!/usr/bin/env -S bun --no-env-file`. Published to npm via `npm publish` run locally
by a human.

Release workflow:
1. Bump `version` in `package.json` by hand.
2. Run `bun run release` — this runs build → verify:dist → test → `npm publish`.
3. No CI automation, no release-please, no OIDC/provenance, no NPM_TOKEN secret.

This mirrors DAMM-sdk's release pattern exactly.

## Rationale

- **Consistency with the AXI toolchain**: all AXI sibling tools (gh-axi, kb-axi, etc.)
  require Bun. Consumers already have it installed. Adding a Node requirement for aws-axi
  alone provides no real benefit — the audience is the same set of machines.
- **Speed**: `bun build` bundles significantly faster than `tsc` and the resulting binary
  runs under Bun's faster JS runtime.
- **Mirrors DAMM-sdk** (the ground truth for DAMM release patterns): DAMM-sdk uses
  `bun build` + a manual `bun run release` script. No `.github/workflows` for release.
  aws-axi adopts the identical flow — same tooling, same human-in-the-loop control.
- **Simpler CI surface**: no NPM_TOKEN secret to rotate, no OIDC trusted-publisher
  config, no release-please bot creating PRs. Human bumps the version, human ships.
- **Explicit control**: every publish is a deliberate human action, which is correct for a
  security-sensitive CLI tool that generates AWS API calls.

## Accepted tradeoff

Consumers need Bun installed. This is the only runtime requirement. This is intentional
and accepted — aws-axi is part of the AXI toolchain which universally assumes Bun.

## Consequences — shebang is load-bearing (do not simplify)

The shebang `#!/usr/bin/env -S bun --no-env-file` is **not cosmetic**. Bun
auto-loads `.env` from the process cwd on startup (Node does not). Any repo that
ships `AWS_ENDPOINT_URL=http://localhost:4566` in its `.env` (e.g. for LocalStack
integration tests) will silently retarget every real-AWS call at localhost, producing
a misleading "Could not connect to the endpoint URL" error — with no indication that
a dotfile is responsible (see issue #32).

`--no-env-file` suppresses the auto-load so aws-axi mirrors the `aws` CLI: only
genuinely-exported shell environment variables and `~/.aws/*` config are honored.
Reverting the shebang to plain `#!/usr/bin/env bun` reopens this footgun.
The `scripts/verify-dist.ts` guard and the `test/no-dotenv.test.ts` shebang
assertion both enforce this: CI will catch any regression.

## Alternative: bun compile (c)

Per-platform standalone binaries eliminate the runtime dependency entirely but require a
CI build matrix (linux-x64, linux-arm64, darwin-arm64, darwin-x64, win-x64) and a
Homebrew tap or GitHub release download flow. Defer to a future slice if demand justifies.

## Impact on slice #14 (setup hooks)

`setup.ts` already handles both the development (`.ts` bin) and packaged forms:

```typescript
function buildHookCommand(execPath: string): string {
  if (execPath.endsWith(".ts")) {
    return `bun run ${execPath}`;   // dev: bun run /abs/path/aws-axi.ts
  }
  return execPath;                   // packaged: /abs/path/dist/bin/aws-axi.js
}
```

After npm install, `process.argv[1]` is the npm shim (e.g., `/usr/local/bin/aws-axi`),
which does not end with `.ts` → `buildHookCommand` returns it directly → hooks store
`/usr/local/bin/aws-axi`, which IS executable and valid for Claude Code, Codex, and
OpenCode. No changes to `setup.ts` are needed for the packaged case.

## Operator-only steps to complete this slice

1. **Register in autoupdate loop** — add `aws-axi` to the `com.axi-tools.autoupdate`
   launchd plist so `aws-axi update` is called on the same cadence as `gh-axi update`.
   The plist lives at `~/Library/LaunchAgents/com.axi-tools.autoupdate.plist`.
2. **Cut the first release** — bump `version` in `package.json`, then run
   `bun run release` from the repo root on your local machine (requires npm login).
