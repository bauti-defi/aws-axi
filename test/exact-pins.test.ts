/**
 * Unit tests for scripts/check-exact-pins.ts.
 *
 * Verifies:
 *   - Exact versions pass
 *   - Caret / tilde ranges fail
 *   - Workspace and file: refs are skipped
 *   - The real aws-axi package.json passes its own check
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkExactPins } from "../scripts/check-exact-pins.js";

function makePkgJson(
  dir: string,
  content: object,
): string {
  const path = join(dir, "package.json");
  writeFileSync(path, JSON.stringify(content), "utf-8");
  return path;
}

describe("checkExactPins", () => {
  it("passes when all deps are exact-pinned", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { foo: "1.2.3", bar: "2.0.0" },
      devDependencies: { baz: "3.4.5" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails for a caret-prefixed dependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { foo: "^1.2.3" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.specifier).toBe("^1.2.3");
    expect(result.violations[0]!.field).toBe("dependencies");
    expect(result.violations[0]!.name).toBe("foo");
  });

  it("fails for a tilde-prefixed devDependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      devDependencies: { baz: "~3.4.5" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.field).toBe("devDependencies");
    expect(result.violations[0]!.specifier).toBe("~3.4.5");
  });

  it("fails for dist-tags (latest / next)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { foo: "latest", bar: "next" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.specifier).sort()).toEqual([
      "latest",
      "next",
    ]);
  });

  it("fails for partial wildcards (1.2.x / 1.x / *)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { a: "1.2.x", b: "1.x", c: "*" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(3);
  });

  it("fails for comparator ranges (>=1.0.0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { foo: ">=1.0.0" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.specifier).toBe(">=1.0.0");
  });

  it("passes for exact prerelease / build-metadata versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { foo: "1.2.3-beta.1", bar: "2.0.0+build.5" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("reports all violations, not just the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { a: "^1.0.0", b: "~2.0.0" },
      devDependencies: { c: "^3.0.0" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(3);
  });

  it("skips workspace: refs (monorepo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { shared: "workspace:*" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(true);
  });

  it("skips file: refs (local dev deps)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, {
      dependencies: { local: "file:../sdk" },
    });
    const result = checkExactPins(path);
    expect(result.ok).toBe(true);
  });

  it("passes with no dependency fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-pins-"));
    const path = makePkgJson(dir, { name: "empty" });
    const result = checkExactPins(path);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("the real aws-axi package.json passes the exact-pin check", () => {
    const packageJsonPath = join(import.meta.dir, "..", "package.json");
    const result = checkExactPins(packageJsonPath);
    expect(result.ok).toBe(
      true,
      `Violations: ${JSON.stringify(result.violations, null, 2)}`,
    );
  });
});
