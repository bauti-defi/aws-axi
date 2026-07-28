/**
 * Budget-rot regression guard (slice #92).
 *
 * Every `it()` in the three real-aws e2e test files must carry an explicit
 * numeric third argument (the per-test timeout budget). Without it, the suite
 * inherits bun's 5000ms CLI default, which is below the measured 5.9s
 * cold-start cost paid by the first real-aws file in alphabetical order.
 *
 * Why structural, not wall-time:
 *   A structural check fires the moment a budget is dropped or omitted from a
 *   new test, rather than only on a slow machine. It adds no real-`aws` spawn
 *   of its own.
 *
 * Real-aws e2e files (in alphabetical order — file order determines who pays
 * the once-per-process macOS aws-cli warm-up cliff):
 *   1. test/no-region-e2e.test.ts
 *   2. test/sso-auth-expired-e2e.test.ts
 *   3. test/wire-reveal.test.ts
 *
 * Guard invariant: every `it(` call in these files must close with
 * `}, <number>)` (a numeric third argument to it()).
 *
 * Algorithm:
 *   - Count `it(` call opens at the top-level indentation of each file.
 *   - Count closings that carry a numeric budget: `}, <digits>)`.
 *   - Assert the two counts match per file and per test.
 *
 * If this test fails, it means a budget was dropped or a new real-aws test
 * was added without a budget — fix it by adding `, 20000` before the closing
 * `)` of the `it()` call.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that spawn the real `aws` binary and therefore need explicit budgets. */
const REAL_AWS_E2E_FILES = [
  "test/no-region-e2e.test.ts",
  "test/sso-auth-expired-e2e.test.ts",
  "test/wire-reveal.test.ts",
] as const;

/**
 * Parse the `it()` calls in a test file and return one entry per call,
 * indicating whether it carries an explicit numeric third argument.
 *
 * Algorithm:
 *   - Scan line-by-line, tracking brace depth to find the closing line of
 *     each `it()` block.
 *   - A closing line is the first line where brace depth returns to 0 after
 *     the `it(` opener.
 *   - An explicit budget is present iff the closing line matches `}, <NUM>)`.
 */
function parseItBudgets(filePath: string): Array<{ name: string; hasBudget: boolean }> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const results: Array<{ name: string; hasBudget: boolean }> = [];

  let inIt = false;
  let braceDepth = 0;
  let currentTestName = "";

  for (const line of lines) {
    if (!inIt) {
      // Match `  it(` or `  it (` — at 2-space or 4-space indent, not inside comments
      // Captures the opening quote character to handle single/double/backtick quotes
      const match = line.match(/^\s{0,6}it\s*\(\s*(["'`])(.+?)\1/);
      if (match) {
        inIt = true;
        braceDepth = 0;
        currentTestName = match[2];
      }
    }

    if (inIt) {
      // Count brace changes on this line (handles same-line opens and closes)
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      braceDepth += opens - closes;

      // When depth returns to 0, we are at the closing line of the it() block
      if (braceDepth <= 0 && closes > 0) {
        // A budget is present when the closing line has `}, NUMBER)`
        // e.g. `  }, 20000);` or `  }, 20000);  // comment`
        const hasBudget = /\},\s*\d{3,6}\s*\)/.test(line);
        results.push({ name: currentTestName, hasBudget });
        inIt = false;
        braceDepth = 0;
      }
    }
  }

  return results;
}

describe("budget-rot guard: real-aws e2e tests must carry explicit per-test timeouts", () => {
  for (const relPath of REAL_AWS_E2E_FILES) {
    const filePath = join(REPO_ROOT, relPath);

    it(`all it() calls in ${relPath} have an explicit numeric budget`, () => {
      const tests = parseItBudgets(filePath);

      // Guard against the parser returning zero (which would make the loop vacuous)
      expect(tests.length).toBeGreaterThan(0);

      for (const { name, hasBudget } of tests) {
        expect(
          hasBudget,
          `${relPath}: it("${name}") is missing a numeric third argument. ` +
            "Add ', 20000' before the closing ) to give it an explicit budget.",
        ).toBe(true);
      }
    });
  }
});
