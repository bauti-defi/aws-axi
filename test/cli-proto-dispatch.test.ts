/**
 * Prototype-safety tests for the CLI command dispatcher (issue #85).
 *
 * Problem: src/cli.ts built OVERLAY_COMMANDS and COMMAND_HELP as plain object
 * literals, so Object.prototype members (toString, constructor, valueOf, etc.)
 * were inherited and visible to the Proxy's Reflect.get and the getCommandHelp
 * callback. This caused:
 *   - `aws-axi toString foo`    → exit 0 (silent false-success)
 *   - `aws-axi constructor foo` → exit 0 (silent false-success)
 *   - `aws-axi valueOf foo`     → exit 255, code UNKNOWN (crash)
 *   - `aws-axi toString --help` → exit 1, uncaught TypeError (crash)
 *   ...and five more prototype keys producing UNKNOWN/255 crashes.
 *
 * Fix: null-prototype object + Object.hasOwn guard, matching the engine's
 * SERVICE_ALIASES pattern (src/engine.ts:80-86 + test/s3api-routing.test.ts:328).
 *
 * Test strategy (mirroring s3api-routing.test.ts):
 *   Y1 — All 8 prototype keys produce exit 252 and a documented taxonomy code
 *        (not UNKNOWN) when used as commands.
 *   Y2 — OVERLAY_COMMANDS table shape: null prototype + frozen.
 *   Y3 — COMMAND_HELP table shape: null prototype + frozen.
 *   Y4 — Positive controls: update/then/catch/finally + a real overlay + engine
 *        service still behave exactly as before.
 *   Y5 — --help on a prototype key does not crash (COMMAND_HELP fix).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, OVERLAY_COMMANDS, COMMAND_HELP } from "../src/cli.js";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";
import { useEnvGuard } from "./helpers/env-guard.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

/** All 8 Object.prototype keys that form the acceptance bar. */
const PROTO_KEYS = [
  "toString",
  "constructor",
  "valueOf",
  "__proto__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

/** Documented taxonomy codes — anything in this set is acceptable. */
const KNOWN_CODES = new Set([
  "USAGE_ERROR",
  "VALIDATION_ERROR",
  "AUTH_EXPIRED",
  "NO_REGION",
  "NO_CREDENTIALS",
  "RUNTIME_ERROR",
]);

afterEach(() => {
  releaseStubBins();
});

useEnvGuard();

// ── captureMain (same pattern as cli-engine.test.ts) ─────────────────────────

async function captureMain(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const stdout = {
    write(chunk: string): true {
      chunks.push(chunk);
      return true;
    },
  };

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  const prevExitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  try {
    await main({ argv, stdout });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  const rawExitCode = process.exitCode as number;
  const exitCode: number | undefined = rawExitCode === 0 ? undefined : rawExitCode;
  process.exitCode = prevExitCode;
  return { output: chunks.join(""), exitCode };
}

function makeStub(exitCode = 0): string {
  return stubBin(`#!/bin/sh\nexit ${exitCode}\n`);
}

function stubDir(bin: string): string {
  return bin.replace(/\/aws$/, "");
}

// ── Y1: All 8 prototype keys must exit non-zero with a known taxonomy code ────
//
// Mutant note: The two guards work together.
//   M1 — remove only the hasOwn guard (keep null proto): hasOwn is redundant
//         once prototype is severed — not a meaningful mutant, but Y2 shape-pin
//         catches "refactor back to plain literal without hasOwn" (M2/M3).
//   M2 — refactor OVERLAY_COMMANDS to plain literal, keep hasOwn: Y2 goes RED.
//   M3 — refactor to plain literal AND remove hasOwn: Y1 goes RED (exit 0/255).
//
// Y1 tests M3 directly; Y2 kills M2. Together they require BOTH defences.

describe("CLI prototype-safety — Y1: prototype keys must not exit 0 or produce UNKNOWN", () => {
  for (const key of PROTO_KEYS) {
    it(`'${key} foo' exits non-zero with a documented code`, async () => {
      const stub = makeStub(0);
      const { output, exitCode } = await captureMain(
        [key, "foo"],
        {
          PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
          AWS_DATA_PATH: FIXTURES_DIR,
        },
      );

      // Must NOT exit 0 — that signals "operation succeeded" to callers.
      expect(exitCode).toBeDefined();
      expect(exitCode).not.toBe(0);

      // Must NOT be the UNKNOWN catch-all — that means aws-axi broke internally.
      // A bad command name is a user error (USAGE_ERROR), not an internal crash.
      // TOON format: "code: UNKNOWN" (no quotes around the value).
      expect(output).not.toContain("code: UNKNOWN");

      // The emitted code must be one the taxonomy documents.
      // TOON format: "code: USAGE_ERROR" (no quotes around the value).
      const codeMatch = output.match(/\bcode:\s*([A-Z_]+)/);
      expect(codeMatch).not.toBeNull();
      const code = codeMatch?.[1] ?? "";
      expect(KNOWN_CODES.has(code)).toBe(true);
    });
  }
});

// ── Y2: OVERLAY_COMMANDS table shape ─────────────────────────────────────────
//
// Mirrors test/s3api-routing.test.ts:328 for SERVICE_ALIASES.
// Pins both defences so that either one reverting to a plain literal is RED.

describe("OVERLAY_COMMANDS — prototype-safety (Y2)", () => {
  it("OVERLAY_COMMANDS has a null prototype and is frozen", () => {
    expect(Object.getPrototypeOf(OVERLAY_COMMANDS)).toBeNull();
    expect(Object.isFrozen(OVERLAY_COMMANDS)).toBe(true);
  });

  it("all 8 inherited Object.prototype keys are undefined in OVERLAY_COMMANDS", () => {
    for (const key of PROTO_KEYS) {
      expect((OVERLAY_COMMANDS as unknown as Record<string, unknown>)[key]).toBeUndefined();
    }
  });
});

// ── Y3: COMMAND_HELP table shape ──────────────────────────────────────────────

describe("COMMAND_HELP — prototype-safety (Y3)", () => {
  it("COMMAND_HELP has a null prototype and is frozen", () => {
    expect(Object.getPrototypeOf(COMMAND_HELP)).toBeNull();
    expect(Object.isFrozen(COMMAND_HELP)).toBe(true);
  });

  it("all 8 inherited Object.prototype keys are undefined in COMMAND_HELP", () => {
    for (const key of PROTO_KEYS) {
      expect((COMMAND_HELP as unknown as Record<string, unknown>)[key]).toBeUndefined();
    }
  });
});

// ── Y4: Positive controls — existing behaviour must be preserved ──────────────

describe("CLI prototype-safety — Y4: positive controls", () => {
  it("'update' still reaches the SDK's built-in updater (not the engine)", async () => {
    const { output } = await captureMain(["update", "--help"], {
      AWS_DATA_PATH: FIXTURES_DIR,
    });
    // Engine dispatch would produce this; verify it does NOT.
    expect(output).not.toMatch(/Unknown service ['"]update['"]/);
    expect(output).toContain("update");
  });

  it("'then' is still denied and does not dispatch to engine", async () => {
    const { output, exitCode } = await captureMain(["then"], {
      AWS_DATA_PATH: FIXTURES_DIR,
    });
    expect(output).not.toMatch(/Unknown service ['"]then['"]/);
    // VALIDATION_ERROR from axi-sdk-js's built-in unknown-command path
    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);
  });

  it("'ec2 describe-vpcs' still routes to the ec2 overlay (not a prototype leak)", async () => {
    const stub = makeStub(0);
    // Stub returns minimal VPC JSON so the overlay's describe-vpcs path can project it
    stubBin(
      `#!/bin/sh\nprintf '%s' '${JSON.stringify({ Vpcs: [{ VpcId: "vpc-abc", CidrBlock: "10.0.0.0/16", State: "available", IsDefault: false, OwnerId: "123", Tags: [] }] })}'\nexit 0\n`,
    );

    // Use a real stub from the pool for ec2
    const ecStub = stubBin(
      `#!/bin/sh\nprintf '%s' '${JSON.stringify({ Vpcs: [{ VpcId: "vpc-ok123", CidrBlock: "10.0.0.0/16", State: "available", IsDefault: false, OwnerId: "123456789012", Tags: [{ Key: "Name", Value: "my-vpc" }] }] })}'\nexit 0\n`,
    );

    const { output, exitCode } = await captureMain(
      ["ec2", "describe-vpcs"],
      {
        PATH: `${stubDir(ecStub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("my-vpc");
    expect(output).not.toContain("USAGE_ERROR");
    expect(exitCode).toBeUndefined();
  });

  it("'fake-svc simple-op' still dispatches through the generic engine", async () => {
    const stub = stubBin(
      `#!/bin/sh\nprintf '%s' '${JSON.stringify({ Value: "engine-still-works" })}'\nexit 0\n`,
    );

    const { output, exitCode } = await captureMain(
      ["fake-svc", "simple-op"],
      {
        PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
        AWS_DATA_PATH: FIXTURES_DIR,
      },
    );

    expect(output).toContain("engine-still-works");
    expect(exitCode).toBeUndefined();
  });
});

// ── Y5: --help on a prototype key must not crash (COMMAND_HELP fix) ───────────
//
// Before the fix: COMMAND_HELP["toString"] returned Function.prototype.toString
// (a function). The SDK passed it to stdout.write() → TypeError, exit 1.
// After the fix: COMMAND_HELP has a null prototype, so "toString" → undefined
// → ?? null → null. The SDK skips the help write and dispatches normally,
// producing a structured USAGE_ERROR (252) instead of a crash.

describe("CLI prototype-safety — Y5: --help on prototype keys must not crash", () => {
  for (const key of PROTO_KEYS) {
    it(`'${key} --help' exits non-zero with no native-code leak in output`, async () => {
      const stub = makeStub(0);
      const { output, exitCode } = await captureMain(
        [key, "--help"],
        {
          PATH: `${stubDir(stub)}:${process.env["PATH"] ?? ""}`,
          AWS_DATA_PATH: FIXTURES_DIR,
        },
      );

      // Must not exit 0 (false-success) or crash with exit 1 (TypeError).
      expect(exitCode).toBeDefined();
      expect(exitCode).not.toBe(0);
      expect(exitCode).not.toBe(1);

      // The in-process captureMain's stdout.write() accepts non-strings without
      // throwing (chunks.push accepts anything). If COMMAND_HELP["key"] still
      // returns a native function, chunks.join("") would contain "native code".
      // With the fix it returns undefined → null → SDK skips write → not in output.
      expect(output).not.toContain("native code");
    });
  }
});
