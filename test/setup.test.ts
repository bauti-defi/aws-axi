/**
 * E2E tests for the setup command and hook installation.
 *
 * Tests exercise the REAL bin path shape: `bin/aws-axi.ts` (a `.ts` file,
 * committed as 100644/non-executable). This is the form that `process.argv[1]`
 * holds during any `bun run bin/aws-axi.ts` invocation — the same shape that
 * previously caused `installSessionStartHooks` to silently no-op while
 * reporting success.
 *
 * Invariants:
 *   - Every test that calls setupRun MUST assert at least one hook file was
 *     actually written. A run that writes nothing fails the test.
 *   - All tests use real temp directories (no mocks).
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setupRun } from "../src/commands/setup.js";

// The REAL bin entrypoint — use its abs path as execPath in all tests.
// This is what process.argv[1] contains during `bun run bin/aws-axi.ts`.
const REAL_BIN = resolve(
  join(import.meta.dir, "..", "bin", "aws-axi.ts"),
);

const tempDirs: string[] = [];

function makeHome(tmp: string): string {
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function claudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

function codexHooksPath(home: string): string {
  return join(home, ".codex", "hooks.json");
}

function codexConfigPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

function openCodePluginPath(home: string): string {
  return join(home, ".config", "opencode", "plugins", "axi-aws-axi.js");
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Happy-path — real .ts bin path shape writes all three targets
// ---------------------------------------------------------------------------

describe("setupRun — writes all targets for the .ts bin path shape", () => {
  it("reports overallStatus: installed when all targets succeed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    const result = setupRun({ homeDir: home, execPath: REAL_BIN });

    expect(result.overallStatus).toBe("installed");
    expect(result.targets["claude-code"].ok).toBe(true);
    expect(result.targets.codex.ok).toBe(true);
    expect(result.targets.opencode.ok).toBe(true);
  });

  it("Claude Code settings.json is written with bun-run hook command", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });

    // File must exist — a no-op / inert run would leave it absent.
    expect(existsSync(claudeSettingsPath(home))).toBe(true);

    const settings = readJson(claudeSettingsPath(home));
    const groups = (
      settings as {
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string; type?: string }> }> };
      }
    ).hooks?.SessionStart ?? [];
    expect(groups.length).toBeGreaterThan(0);

    const hookEntry = (groups as Array<{ hooks?: Array<{ command?: string; type?: string }> }>)[0]
      ?.hooks?.[0];
    expect(hookEntry?.type).toBe("command");
    // Command must use "bun run" (not a bare .ts path that would fail with permission denied).
    expect(hookEntry?.command).toContain("aws-axi");
    expect(hookEntry?.command).toMatch(/^bun run .+aws-axi\.ts$/);
  });

  it("Codex hooks.json is written with bun-run hook command", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });

    expect(existsSync(codexHooksPath(home))).toBe(true);

    const hooks = readJson(codexHooksPath(home));
    const groups = (
      hooks as {
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
      }
    ).hooks?.SessionStart ?? [];
    expect(groups.length).toBeGreaterThan(0);

    const cmd = (groups as Array<{ hooks?: Array<{ command?: string }> }>)[0]?.hooks?.[0]?.command;
    expect(cmd).toMatch(/^bun run .+aws-axi\.ts$/);
  });

  it("Codex config.toml is written with hooks = true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });

    expect(existsSync(codexConfigPath(home))).toBe(true);
    const toml = readFileSync(codexConfigPath(home), "utf-8");
    expect(toml).toContain("[features]");
    expect(toml).toContain("hooks = true");
  });

  it("OpenCode plugin is written with managed marker and correct split-arg spawn", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });

    expect(existsSync(openCodePluginPath(home))).toBe(true);

    const plugin = readFileSync(openCodePluginPath(home), "utf-8");
    expect(plugin).toContain("axi-sdk-js managed opencode plugin: aws-axi");
    expect(plugin).toContain("experimental.chat.system.transform");
    expect(plugin).toContain("AxiAwsAxiAmbientContextPlugin");
    // Must use split-args spawn so Node spawn with shell:false works correctly.
    // A single-string "bun run /path/aws-axi.ts" would fail for shell:false.
    expect(plugin).toContain('"bun", ["run",');
    // Must reference the actual bin path
    expect(plugin).toContain("aws-axi.ts");
  });
});

// ---------------------------------------------------------------------------
// Idempotency — second run is a no-op; no duplicate hook groups
// ---------------------------------------------------------------------------

describe("setupRun — idempotency", () => {
  it("Claude Code settings.json is byte-identical after second run", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });
    const after1 = readFileSync(claudeSettingsPath(home), "utf-8");

    setupRun({ homeDir: home, execPath: REAL_BIN });
    const after2 = readFileSync(claudeSettingsPath(home), "utf-8");

    expect(after2).toBe(after1);
  });

  it("exactly one managed hook group after two runs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });
    setupRun({ homeDir: home, execPath: REAL_BIN });

    const settings = readJson(claudeSettingsPath(home));
    const groups =
      (
        settings as {
          hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
        }
      ).hooks?.SessionStart ?? [];
    const managed = (groups as Array<{ hooks?: Array<{ command?: string }> }>).filter(
      (g) => g.hooks?.some((h) => h.command?.includes("aws-axi")),
    );
    expect(managed).toHaveLength(1);
  });

  it("Codex config.toml is byte-identical after second run", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });
    const after1 = readFileSync(codexConfigPath(home), "utf-8");

    setupRun({ homeDir: home, execPath: REAL_BIN });
    const after2 = readFileSync(codexConfigPath(home), "utf-8");

    expect(after2).toBe(after1);
  });

  it("OpenCode plugin is byte-identical after second run", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    setupRun({ homeDir: home, execPath: REAL_BIN });
    const after1 = readFileSync(openCodePluginPath(home), "utf-8");

    setupRun({ homeDir: home, execPath: REAL_BIN });
    const after2 = readFileSync(openCodePluginPath(home), "utf-8");

    expect(after2).toBe(after1);
  });
});

// ---------------------------------------------------------------------------
// Path repair — stale hook command is corrected in-place
// ---------------------------------------------------------------------------

describe("setupRun — path repair", () => {
  it("repairs a stale hook path in Claude Code settings.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    // Seed a stale hook pointing to a fake old .ts path
    const oldBinDir = join(tmp, "v1", "bin");
    mkdirSync(oldBinDir, { recursive: true });
    const oldBin = join(oldBinDir, "aws-axi.ts");
    writeFileSync(oldBin, "// old stub\n", "utf-8");

    setupRun({ homeDir: home, execPath: oldBin });
    const staleCmd = (
      readJson(claudeSettingsPath(home)) as {
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
      }
    ).hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    expect(staleCmd).toBe(`bun run ${oldBin}`);

    // Re-run with a new execPath — must repair the hook command in-place.
    const newBinDir = join(tmp, "v2", "bin");
    mkdirSync(newBinDir, { recursive: true });
    const newBin = join(newBinDir, "aws-axi.ts");
    writeFileSync(newBin, "// new stub\n", "utf-8");

    setupRun({ homeDir: home, execPath: newBin });

    const repairedCmd = (
      readJson(claudeSettingsPath(home)) as {
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
      }
    ).hooks?.SessionStart?.[0]?.hooks?.[0]?.command;

    // Must be updated to the new path, not the old one
    expect(repairedCmd).toBe(`bun run ${newBin}`);
    expect(repairedCmd).toMatch(/^bun run .+aws-axi\.ts$/);
  });

  it("exactly one managed hook group after repair", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    const oldBinDir = join(tmp, "v1", "bin");
    mkdirSync(oldBinDir, { recursive: true });
    const oldBin = join(oldBinDir, "aws-axi.ts");
    writeFileSync(oldBin, "// old\n", "utf-8");
    setupRun({ homeDir: home, execPath: oldBin });

    const newBinDir = join(tmp, "v2", "bin");
    mkdirSync(newBinDir, { recursive: true });
    const newBin = join(newBinDir, "aws-axi.ts");
    writeFileSync(newBin, "// new\n", "utf-8");
    setupRun({ homeDir: home, execPath: newBin });

    const settings = readJson(claudeSettingsPath(home));
    const groups =
      (
        settings as {
          hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
        }
      ).hooks?.SessionStart ?? [];
    const managed = (groups as Array<{ hooks?: Array<{ command?: string }> }>).filter(
      (g) => g.hooks?.some((h) => h.command?.includes("aws-axi")),
    );
    expect(managed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error surface — malformed JSON must be reported, not swallowed
// ---------------------------------------------------------------------------

describe("setupRun — honest error reporting", () => {
  it("surfaces malformed settings.json as a per-target error, not a silent no-op", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    // Pre-seed a corrupt Claude Code settings file
    const settingsDir = join(home, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), "{ INVALID JSON }", "utf-8");

    const result = setupRun({ homeDir: home, execPath: REAL_BIN });

    // claude-code target must report the error, not silently succeed
    expect(result.targets["claude-code"].ok).toBe(false);
    expect(result.targets["claude-code"].error).toBeTruthy();
    // overallStatus must reflect the partial failure
    expect(result.overallStatus).toBe("partial");
  });

  it("reports partial status and refuses to overwrite unmanaged OpenCode plugin", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    // Pre-seed an unmanaged OpenCode plugin
    const pluginDir = join(home, ".config", "opencode", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "axi-aws-axi.js"),
      "export const UserPlugin = async () => ({})\n",
      "utf-8",
    );

    const result = setupRun({ homeDir: home, execPath: REAL_BIN });

    expect(result.targets.opencode.ok).toBe(false);
    expect(result.targets.opencode.error).toContain("refusing to overwrite");
    expect(result.overallStatus).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// setupCommand — CLI adapter validation
// ---------------------------------------------------------------------------

describe("setupCommand — argument validation", () => {
  it("rejects unknown subcommands with AxiError", async () => {
    const { setupCommand } = await import("../src/commands/setup.js");
    const { AxiError } = await import("axi-sdk-js");

    await expect(setupCommand(["unknown"], undefined)).rejects.toBeInstanceOf(AxiError);
  });

  it("rejects empty args with AxiError", async () => {
    const { setupCommand } = await import("../src/commands/setup.js");
    const { AxiError } = await import("axi-sdk-js");

    await expect(setupCommand([], undefined)).rejects.toBeInstanceOf(AxiError);
  });

  it("accepts 'hooks' and returns structured per-target output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    const { setupCommand } = await import("../src/commands/setup.js");

    const result = await setupCommand(["hooks"], undefined, {
      homeDir: home,
      execPath: REAL_BIN,
    });

    expect(result).toMatchObject({
      hooks: {
        status: "installed",
        targets: {
          "claude-code": { status: "ok" },
          codex: { status: "ok" },
          opencode: { status: "ok" },
        },
      },
    });
  });
});
