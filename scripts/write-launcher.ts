#!/usr/bin/env bun
/**
 * Write the POSIX sh launcher to dist/bin/aws-axi.
 *
 * The launcher is the entry point users invoke when running the installed CLI.
 * It resolves symlinks so npm/bun global installs (which symlink the file into
 * a separate bin directory) still find the sibling aws-axi.js module.  It then
 * execs Bun with --no-env-file, preventing Bun's automatic .env loading from
 * the user's cwd — matching the aws CLI's behavior (see issue #32).
 *
 * Why a POSIX sh launcher instead of #!/usr/bin/env -S bun --no-env-file:
 *   env -S is unsupported on BusyBox (Alpine ≥3.20 ships BusyBox env), making
 *   the CLI completely unrunnable on Alpine.  A #!/bin/sh launcher works on
 *   macOS, glibc Linux, AND Alpine/BusyBox with no extra dependencies.
 *
 * Usage:
 *   bun run scripts/write-launcher.ts    (called by `bun run build`)
 */

import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const LAUNCHER = join(ROOT, "dist", "bin", "aws-axi");

/**
 * The launcher content.  Shell variables ($0, $_self, etc.) are intentionally
 * NOT interpolated here — they are shell variables, not JS template literals.
 *
 * The symlink-resolution loop:
 *   1. Reads $0 (the file's own path, which may be a symlink).
 *   2. Follows each symlink level via `readlink` (one level at a time, POSIX).
 *   3. Handles both absolute and relative symlink targets.
 *   4. When $0 is no longer a symlink, cd into its directory for the canonical path.
 *   5. Exec bun --no-env-file on the sibling aws-axi.js, forwarding all args.
 */
const LAUNCHER_CONTENT = `#!/bin/sh
# Portable POSIX launcher for aws-axi.
# Resolves symlinks so npm/bun global installs (which symlink this file
# into a bin directory) can still find the sibling aws-axi.js module.
# POSIX-portable; works on macOS, glibc Linux, and Alpine/BusyBox.
_self="$0"
while [ -L "$_self" ]; do
  _dir=$(cd "$(dirname "$_self")" && pwd)
  _link=$(readlink "$_self")
  case "$_link" in
    /*) _self="$_link" ;;
    *)  _self="$_dir/$_link" ;;
  esac
done
_dir=$(cd "$(dirname "$_self")" && pwd)
exec bun --no-env-file "$_dir/aws-axi.js" "$@"
`;

writeFileSync(LAUNCHER, LAUNCHER_CONTENT, "utf-8");
chmodSync(LAUNCHER, 0o755);
console.log(`Wrote ${LAUNCHER}`);
