/**
 * Verify that every entry in dependencies and devDependencies uses an exact
 * version pin — no "^", "~", or open range specifiers.
 *
 * Usage (CI + dev):
 *   bun run check:pins              # via package.json script
 *   bun run scripts/check-exact-pins.ts
 *
 * The `checkExactPins` function is also exported for unit tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PinViolation {
  readonly field: "dependencies" | "devDependencies";
  readonly name: string;
  readonly specifier: string;
}

export interface PinCheckResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<PinViolation>;
}

/**
 * Check a package.json file for non-exact dependency version specifiers.
 *
 * Flags:
 *   - Caret ranges:  "^1.2.3"
 *   - Tilde ranges:  "~1.2.3"
 *   - Comparators:   ">1.0.0", ">=1.0.0", "<2.0.0"
 *   - Wildcards:     "*", "x"
 *
 * Allows:
 *   - Exact versions: "1.2.3"
 *   - Workspace refs: "workspace:*" (monorepo relative — skip these)
 *   - "file:..." local deps (development iteration — skip these)
 */
export function checkExactPins(packageJsonPath: string): PinCheckResult {
  const raw = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const violations: PinViolation[] = [];

  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = raw[field];
    if (deps == null) continue;
    for (const [name, specifier] of Object.entries(deps)) {
      // Skip workspace and local-file references — these are dev-only shorthands.
      if (specifier.startsWith("workspace:") || specifier.startsWith("file:")) {
        continue;
      }
      if (/^[\^~]/.test(specifier) || /^\s*[<>*x]/.test(specifier)) {
        violations.push({ field, name, specifier });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// Run the check when invoked directly as a script.
if (import.meta.main) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const packageJsonPath = join(here, "..", "package.json");
  const result = checkExactPins(packageJsonPath);

  if (!result.ok) {
    console.error("Exact-pin violations found in package.json:");
    for (const v of result.violations) {
      console.error(`  ${v.field}.${v.name}: "${v.specifier}"`);
    }
    console.error(
      "\nAll deps must be exact-pinned. Use `bun add --exact <pkg>` or strip the ^ / ~ prefix.",
    );
    process.exit(1);
  }

  console.log("All dependency pins are exact. OK.");
}
