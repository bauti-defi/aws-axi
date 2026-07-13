/**
 * Regression tests for the cli.ts main() entry point.
 *
 * Residual #1 — banner bin: field must show the launcher, not the .js module.
 *
 * Root cause: axi-sdk-js's homeHeaderOutput reads process.argv[1] as the
 * fallback for the `bin:` field shown in the no-arg dashboard banner.  After
 * the POSIX sh launcher execs `bun --no-env-file dist/bin/aws-axi.js`, Bun
 * sets process.argv[1] to dist/bin/aws-axi.js — the .js module, NOT the
 * launcher.  runAxiCli does not expose an execPath option that would let us
 * pass the right path through the SDK API.
 *
 * Fix: before calling runAxiCli, main() patches process.argv[1] to the value
 * of AWS_AXI_BIN (which the launcher exports as its own resolved path before
 * exec-ing Bun).  homeHeaderOutput then picks up the correct launcher path.
 *
 * Without this fix the banner would contain "aws-axi.js", which an agent
 * would invoke directly — bypassing --no-env-file and re-opening issue #32.
 *
 * FAILS IF REVERTED: removing the process.argv[1] patch causes:
 *   - expect(process.argv[1]).toBe(fakeLauncher) to fail
 *   - expect(output).toContain(fakeLauncher) to fail
 *   - expect(output).not.toContain("aws-axi.js") to fail
 */
import { describe, it, expect } from "bun:test";
import { main } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Residual #1 regression guard — banner argv[1] patch
// ---------------------------------------------------------------------------

describe("main — banner bin: field uses AWS_AXI_BIN launcher path (residual #1)", () => {
  it(
    "patches process.argv[1] to AWS_AXI_BIN before homeHeaderOutput runs",
    async () => {
      const fakeLauncher = "/usr/local/bin/aws-axi";
      const savedArgv1 = process.argv[1];
      const savedEnvBin = process.env["AWS_AXI_BIN"];

      // Simulate post-exec state: argv[1] is the .js module, not the launcher.
      process.argv[1] = "/usr/local/lib/node_modules/aws-axi/dist/bin/aws-axi.js";
      process.env["AWS_AXI_BIN"] = fakeLauncher;

      const chunks: string[] = [];
      try {
        // argv: [] → runAxiCli sees command = argv[0] = undefined → triggers the
        // home view.  homeCommand catches any AWS credential failures and returns
        // {status:"not authenticated"}, so this is safe without real AWS creds.
        await main({
          argv: [],
          stdout: {
            write: (chunk: string) => {
              chunks.push(chunk);
            },
          },
        });

        // After main() returns, process.argv[1] must have been patched.
        // FAILS IF REVERTED: without the patch, argv[1] stays as aws-axi.js.
        expect(process.argv[1]).toBe(fakeLauncher);

        // The banner output must contain the launcher path.
        const output = chunks.join("");
        expect(output).toContain(fakeLauncher);

        // The .js module path must NOT appear in the banner.
        // FAILS IF REVERTED: without the patch, the banner shows aws-axi.js.
        expect(output).not.toContain("aws-axi.js");
      } finally {
        process.argv[1] = savedArgv1;
        if (savedEnvBin === undefined) {
          delete process.env["AWS_AXI_BIN"];
        } else {
          process.env["AWS_AXI_BIN"] = savedEnvBin;
        }
      }
    },
    20_000,
  );
});
