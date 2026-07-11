/**
 * E2E tests for the setup command and hook installation.
 * Real filesystem (mkdtempSync), no mocks — real installSessionStartHooks runs.
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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupRun } from "../src/commands/setup.js";

const FAKE_EXEC_SUFFIX = "dist/bin/aws-axi.js";

function makeHome(tmp: string): string {
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function makeFakeExec(tmp: string): string {
  const dir = join(tmp, "pkg", "dist", "bin");
  mkdirSync(dir, { recursive: true });
  const execFile = join(dir, "aws-axi.js");
  writeFileSync(execFile, "// stub aws-axi dist entrypoint\n", "utf-8");
  return execFile;
}

function readClaudeSettings(home: string): Record<string, unknown> {
  const p = join(home, ".claude", "settings.json");
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function readCodexHooks(home: string): Record<string, unknown> {
  const p = join(home, ".codex", "hooks.json");
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function readCodexConfig(home: string): string {
  return readFileSync(join(home, ".codex", "config.toml"), "utf-8");
}

function openCodePluginPath(home: string): string {
  return join(home, ".config", "opencode", "plugins", "axi-aws-axi.js");
}

const tempDirs: string[] = [];

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
// Happy-path installation across all three targets
// ---------------------------------------------------------------------------

describe("setupRun — installs hooks across all three agent targets", () => {
  it("writes Claude Code settings.json SessionStart hook", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    setupRun({ homeDir: home, execPath });

    const settings = readClaudeSettings(home);
    const hooks = (settings as { hooks?: { SessionStart?: unknown[] } }).hooks;
    expect(Array.isArray(hooks?.SessionStart)).toBe(true);
    const group = (hooks?.SessionStart as Array<{ hooks?: unknown[] }>)[0];
    expect(group?.hooks).toBeDefined();
    const entry = (group?.hooks as Array<{ command?: string; type?: string }>)[0];
    expect(typeof entry?.command).toBe("string");
    expect(entry?.command).toContain("aws-axi");
    expect(entry?.type).toBe("command");
  });

  it("writes Codex hooks.json SessionStart hook", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    setupRun({ homeDir: home, execPath });

    const hooks = readCodexHooks(home);
    const sessionStart = (hooks as { hooks?: { SessionStart?: unknown[] } }).hooks?.SessionStart;
    expect(Array.isArray(sessionStart)).toBe(true);
  });

  it("writes Codex config.toml with hooks = true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    setupRun({ homeDir: home, execPath });

    const toml = readCodexConfig(home);
    expect(toml).toContain("[features]");
    expect(toml).toContain("hooks = true");
  });

  it("writes OpenCode plugin file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    setupRun({ homeDir: home, execPath });

    expect(existsSync(openCodePluginPath(home))).toBe(true);
    const plugin = readFileSync(openCodePluginPath(home), "utf-8");
    expect(plugin).toContain("axi-sdk-js managed opencode plugin: aws-axi");
    expect(plugin).toContain("experimental.chat.system.transform");
  });
});

// ---------------------------------------------------------------------------
// Idempotency — second run is a no-op
// ---------------------------------------------------------------------------

describe("setupRun — idempotency (second run produces identical state)", () => {
  it("Claude Code settings.json is unchanged on second run", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    setupRun({ homeDir: home, execPath });
    const after1 = readFileSync(join(home, ".claude", "settings.json"), "utf-8");

    setupRun({ homeDir: home, execPath });
    const after2 = readFileSync(join(home, ".claude", "settings.json"), "utf-8");

    expect(after2).toBe(after1);
  });

  it("hooks appear exactly once in settings.json after two runs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    setupRun({ homeDir: home, execPath });
    setupRun({ homeDir: home, execPath });

    const settings = readClaudeSettings(home);
    const groups = (settings as { hooks?: { SessionStart?: unknown[] } }).hooks?.SessionStart ?? [];
    const managedGroups = (groups as Array<{ hooks?: Array<{ command?: string }> }>).filter(
      (g) => g.hooks?.some((h) => h.command?.includes("aws-axi")),
    );
    expect(managedGroups).toHaveLength(1);
  });

  it("Codex config.toml is unchanged on second run", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    setupRun({ homeDir: home, execPath });
    const after1 = readCodexConfig(home);

    setupRun({ homeDir: home, execPath });
    const after2 = readCodexConfig(home);

    expect(after2).toBe(after1);
  });
});

// ---------------------------------------------------------------------------
// Path repair — stale hook command is corrected
// ---------------------------------------------------------------------------

describe("setupRun — path repair", () => {
  it("repairs a stale hook path in Claude Code settings.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    // Pre-seed a stale hook pointing to an old path
    const oldExecDir = join(tmp, "old", "dist", "bin");
    mkdirSync(oldExecDir, { recursive: true });
    const oldExec = join(oldExecDir, "aws-axi.js");
    writeFileSync(oldExec, "// old\n", "utf-8");

    setupRun({ homeDir: home, execPath: oldExec });
    const staleSettings = readClaudeSettings(home);
    const staleCmd = (
      staleSettings as { hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> } }
    ).hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    expect(staleCmd).toContain("aws-axi");

    // Now setup with a new exec path — should repair in place
    const newExecDir = join(tmp, "new", "dist", "bin");
    mkdirSync(newExecDir, { recursive: true });
    const newExec = join(newExecDir, "aws-axi.js");
    writeFileSync(newExec, "// new\n", "utf-8");

    setupRun({ homeDir: home, execPath: newExec });

    const repairedSettings = readClaudeSettings(home);
    const repairedCmd = (
      repairedSettings as { hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> } }
    ).hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    expect(repairedCmd).toContain(newExec);
    expect(repairedCmd).not.toBe(staleCmd);
  });

  it("still has exactly one managed hook group after repair", () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);

    const oldExecDir = join(tmp, "old", "dist", "bin");
    mkdirSync(oldExecDir, { recursive: true });
    const oldExec = join(oldExecDir, "aws-axi.js");
    writeFileSync(oldExec, "// old\n", "utf-8");
    setupRun({ homeDir: home, execPath: oldExec });

    const newExecDir = join(tmp, "new", "dist", "bin");
    mkdirSync(newExecDir, { recursive: true });
    const newExec = join(newExecDir, "aws-axi.js");
    writeFileSync(newExec, "// new\n", "utf-8");
    setupRun({ homeDir: home, execPath: newExec });

    const settings = readClaudeSettings(home);
    const groups =
      (settings as { hooks?: { SessionStart?: unknown[] } }).hooks?.SessionStart ?? [];
    const managedGroups = (groups as Array<{ hooks?: Array<{ command?: string }> }>).filter(
      (g) => g.hooks?.some((h) => h.command?.includes("aws-axi")),
    );
    expect(managedGroups).toHaveLength(1);
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

  it("accepts 'hooks' subcommand and returns structured output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aws-axi-setup-"));
    tempDirs.push(tmp);
    const home = makeHome(tmp);
    const execPath = makeFakeExec(tmp);

    const { setupCommand } = await import("../src/commands/setup.js");

    const result = await setupCommand(["hooks"], undefined, { homeDir: home, execPath });
    expect(result).toMatchObject({ hooks: { status: "installed" } });
  });
});
