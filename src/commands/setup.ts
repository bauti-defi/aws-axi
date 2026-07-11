/**
 * `aws-axi setup` — idempotently install / repair SessionStart hooks for the
 * three agent targets: Claude Code, Codex, and OpenCode.
 *
 * Design constraints:
 *   - The bin entrypoint is `bin/aws-axi.ts` (100644 — not executable). Direct
 *     exec via shebang fails on agents that use spawn/exec without shell.
 *   - `installSessionStartHooks` derives the command from `execPath` and stores
 *     the bare path — unusable for a non-executable `.ts` file.
 *   - We bypass the high-level SDK function and use the exported low-level
 *     primitives (`computeSessionStartHookUpdate`, `computeCodexConfigUpdate`)
 *     directly so we can write the correct `bun run <abs-path>` command form.
 *   - Status is DERIVED from actual per-target write results — never hardcoded.
 *
 * NOTE: The hook command form (`bun run <abs-path>`) is specific to the
 * current git-clone / Bun-native distribution. It will be revisited in the
 * packaging slice (#15) once the distribution runtime is chosen (bun compile
 * standalone binary, npm shim, Homebrew tap, etc.). For a packaged install the
 * correct command is the binary name (on PATH) or its absolute dist entrypoint.
 *
 * Exported shape:
 *   setupRun(options?)    — testable core (real filesystem, no mocks)
 *   setupCommand(args, context, options?) — AxiCliCommand adapter for the CLI
 */
import {
  computeSessionStartHookUpdate,
  computeCodexConfigUpdate,
  type HookSettings,
  type ManagedHookSpec,
} from "axi-sdk-js";
import { AxiError } from "axi-sdk-js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AwsContext } from "../context.js";

// The identity marker embedded in every managed hook / plugin so we can find
// and update it on subsequent runs without touching unrelated config.
const MARKER = "aws-axi";

// Prefix used by axi-sdk-js to mark managed OpenCode plugin files.
// Must match the SDK prefix so we stay compatible if the SDK ever re-reads it.
const OPENCODE_PLUGIN_MANAGED_PREFIX = "axi-sdk-js managed opencode plugin:";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SetupRunOptions {
  /** Override the HOME directory — for test isolation only. */
  readonly homeDir?: string;
  /**
   * Override the CLI executable path — for test isolation only.
   * Defaults to `process.argv[1]` (the current invocation path).
   */
  readonly execPath?: string;
}

export interface TargetStatus {
  /** `true` if the target config was present / up-to-date or just written. */
  readonly ok: boolean;
  /** Present only when an error was encountered for this target. */
  readonly error?: string;
}

export interface SetupTargets {
  readonly "claude-code": TargetStatus;
  readonly codex: TargetStatus;
  readonly opencode: TargetStatus;
}

export interface SetupResult {
  readonly targets: SetupTargets;
  /** `"installed"` if all targets ok, `"partial"` if some failed. */
  readonly overallStatus: "installed" | "partial";
}

export const SETUP_HELP = `usage: aws-axi setup hooks
Install or repair agent SessionStart hooks for aws-axi ambient context.

Idempotent — safe to re-run. Repairs a stale or incorrect hook path in-place.
Errors are reported per-target; a partial failure is surfaced, not swallowed.

Supported agent targets:
  - Claude Code  (~/.claude/settings.json)
  - Codex        (~/.codex/hooks.json + ~/.codex/config.toml)
  - OpenCode     (~/.config/opencode/plugins/)

examples:
  aws-axi setup hooks
`;

// ---------------------------------------------------------------------------
// Hook command resolution
// ---------------------------------------------------------------------------

/**
 * Build the portable hook command for the current invocation.
 *
 * `bin/aws-axi.ts` is committed as 100644 (no execute bit), so a bare
 * exec-path stored as the hook command fails for any agent that spawns it
 * directly (permission denied / EACCES). We prefix `bun run` so agents can
 * launch the home view regardless of executable permissions.
 *
 * Claude Code and Codex run hook commands via shell, so a multi-word string
 * works correctly. For OpenCode (Node spawn with shell:false), the custom
 * plugin generator below splits the command into ["bun", "run", execPath].
 *
 * NOTE: revisit in packaging slice #15 — once built as a compiled standalone
 * binary or published npm package, the hook command becomes the binary name /
 * dist entrypoint and no longer needs the `bun run` prefix.
 */
function buildHookCommand(execPath: string): string {
  if (execPath.endsWith(".ts")) {
    return `bun run ${execPath}`;
  }
  // Packaged form: the binary is directly executable (npm shim, bun compile, etc.)
  return execPath;
}

// ---------------------------------------------------------------------------
// OpenCode plugin generator
// ---------------------------------------------------------------------------

/**
 * Generate a managed OpenCode plugin source for the given execPath.
 *
 * Mirrors the structure produced by axi-sdk-js's `buildOpenCodeAmbientPluginSource`
 * (which is internal / not exported) but handles the `.ts` case: instead of
 * `spawn(fullCommand, [], {shell:false})` where `fullCommand = "bun run /path/ts"`
 * contains spaces and fails in Node's spawn, we emit
 * `spawn("bun", ["run", execPath], {shell:false})`.
 * For packaged binaries (no `.ts` extension) the single-executable form is
 * used, matching the SDK's template exactly.
 */
function buildOpenCodePluginSource(
  execPath: string,
  timeoutSeconds: number,
): string {
  const managedMarker = `${OPENCODE_PLUGIN_MANAGED_PREFIX} ${MARKER}`;
  // Export name mirrors the SDK sanitizeOpenCodeExportName("aws-axi") result.
  const exportName = "AxiAwsAxiAmbientContextPlugin";
  const ambientHeader = `## AXI ambient context: ${MARKER}`;

  // Emit a spawn call that correctly handles multi-word invocations:
  //   .ts:       spawn("bun", ["run", "/abs/path/bin/aws-axi.ts"], {shell:false})
  //   packaged:  spawn("/abs/path/aws-axi", [], {shell:false})
  const spawnCall = execPath.endsWith(".ts")
    ? `spawn("bun", ["run", ${JSON.stringify(execPath)}], {`
    : `spawn(${JSON.stringify(execPath)}, [], {`;

  return `// ${managedMarker}
// This file is generated by aws-axi. It is safe to edit only if you remove the managed marker above.
import { spawn } from "node:child_process";

const marker = ${JSON.stringify(MARKER)};
const ambientHeader = ${JSON.stringify(ambientHeader)};
const timeoutMs = ${JSON.stringify(timeoutSeconds * 1000)};

function runAxiHomeView(cwd) {
  return new Promise((resolve) => {
    const child = ${spawnCall}
      cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve("error: " + marker + " ambient context timed out after " + timeoutMs + "ms");
    }, timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("error: " + marker + " ambient context failed: " + error.message);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolve(stdout.trim()); return; }
      resolve("error: " + marker + " ambient context failed: exited with code " + code);
    });
  });
}

function directoryOrFallback(directory) {
  return typeof directory === "string" && directory.length > 0
    ? directory
    : process.cwd();
}

export const ${exportName} = async ({ directory }) => {
  const sessionCache = new Map();

  return {
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID ?? "__global__";
      let homeView = sessionCache.get(sessionID);
      if (homeView === undefined) {
        homeView = await runAxiHomeView(directory);
        sessionCache.set(sessionID, homeView);
      }

      if (homeView.length === 0) return;
      output.system.push(ambientHeader + "\\n" + homeView);
    },
  };
};
`;
}

// ---------------------------------------------------------------------------
// Per-target installers — each returns a TargetStatus
// ---------------------------------------------------------------------------

function installJsonHook(
  target: string,
  command: string,
  timeoutSeconds: number,
): TargetStatus {
  try {
    mkdirSync(dirname(target), { recursive: true });
    const current: HookSettings = existsSync(target)
      ? (JSON.parse(readFileSync(target, "utf-8")) as HookSettings)
      : {};
    const spec: ManagedHookSpec = {
      marker: MARKER,
      command,
      timeoutSeconds,
    };
    const [updated, changed] = computeSessionStartHookUpdate(current, spec);
    if (changed) {
      writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${target}: ${message}` };
  }
}

function installCodexConfig(configPath: string): TargetStatus {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    const current = existsSync(configPath)
      ? readFileSync(configPath, "utf-8")
      : "";
    const [updated, changed] = computeCodexConfigUpdate(current);
    if (changed) {
      writeFileSync(configPath, updated, "utf-8");
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${configPath}: ${message}` };
  }
}

function installOpenCodePlugin(
  home: string,
  execPath: string,
  timeoutSeconds: number,
): TargetStatus {
  const pluginPath = join(
    home,
    ".config",
    "opencode",
    "plugins",
    "axi-aws-axi.js",
  );
  const managedMarker = `${OPENCODE_PLUGIN_MANAGED_PREFIX} ${MARKER}`;
  const next = buildOpenCodePluginSource(execPath, timeoutSeconds);

  try {
    mkdirSync(dirname(pluginPath), { recursive: true });
    const current = existsSync(pluginPath)
      ? readFileSync(pluginPath, "utf-8")
      : undefined;

    // Refuse to overwrite a plugin file that wasn't created by aws-axi.
    if (current !== undefined && !current.includes(managedMarker)) {
      return {
        ok: false,
        error: `${pluginPath}: refusing to overwrite unmanaged OpenCode plugin`,
      };
    }

    if (current !== next) {
      writeFileSync(pluginPath, next, "utf-8");
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${pluginPath}: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Core logic — installs / repairs hooks for all three agent targets and
 * returns the ACTUAL per-target result. Never hardcodes "installed" —
 * status is derived from what was (or wasn't) written.
 */
export function setupRun(options: SetupRunOptions = {}): SetupResult {
  const rawExecPath = options.execPath ?? process.argv[1] ?? "";
  const execPath = resolve(rawExecPath);
  const command = buildHookCommand(execPath);
  const home = options.homeDir ?? homedir();
  const timeoutSeconds = 10;

  const claudeCodeResult = installJsonHook(
    join(home, ".claude", "settings.json"),
    command,
    timeoutSeconds,
  );

  // Codex has two config surfaces: hooks.json (JSON hook) + config.toml (feature flag).
  const codexHookResult = installJsonHook(
    join(home, ".codex", "hooks.json"),
    command,
    timeoutSeconds,
  );
  const codexConfigResult = installCodexConfig(join(home, ".codex", "config.toml"));

  // Codex target is ok only if both surfaces succeeded.
  const codexResult: TargetStatus =
    codexHookResult.ok && codexConfigResult.ok
      ? { ok: true }
      : {
          ok: false,
          error: [codexHookResult.error, codexConfigResult.error]
            .filter(Boolean)
            .join("; "),
        };

  const openCodeResult = installOpenCodePlugin(home, execPath, timeoutSeconds);

  const targets: SetupTargets = {
    "claude-code": claudeCodeResult,
    codex: codexResult,
    opencode: openCodeResult,
  };

  const allOk = claudeCodeResult.ok && codexResult.ok && openCodeResult.ok;
  return {
    targets,
    overallStatus: allOk ? "installed" : "partial",
  };
}

/**
 * AxiCliCommand adapter for `aws-axi setup`.
 * Accepts an optional third argument (SetupRunOptions) for test isolation —
 * in production the CLI calls this with two arguments only.
 */
export async function setupCommand(
  args: string[],
  _context: AwsContext | undefined,
  options: SetupRunOptions = {},
): Promise<Record<string, unknown>> {
  if (args.length !== 1 || args[0] !== "hooks") {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", [
      "Run `aws-axi setup hooks` to install agent SessionStart hooks",
    ]);
  }

  const result = setupRun(options);

  // Build the targets output — include error fields only when present so the
  // TOON rendering stays minimal for the happy path.
  const targetsOut: Record<string, unknown> = {};
  for (const [name, status] of Object.entries(result.targets)) {
    targetsOut[name] = status.error !== undefined
      ? { status: "error", error: status.error }
      : { status: "ok" };
  }

  const help: string[] =
    result.overallStatus === "installed"
      ? ["Restart your agent session to receive aws-axi ambient context"]
      : ["One or more targets failed — check the error fields above"];

  return {
    hooks: {
      status: result.overallStatus,
      targets: targetsOut,
    },
    help,
  };
}
