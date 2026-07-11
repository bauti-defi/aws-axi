/**
 * `aws-axi setup` — idempotently install / repair SessionStart hooks for the
 * three agent targets: Claude Code, Codex, and OpenCode.
 *
 * Delegates to axi-sdk-js `installSessionStartHooks`, which handles all three
 * targets in a single call and is safe to re-run (no-op when hooks are
 * already correct, repairs stale paths in-place).
 *
 * Exported shape:
 *   setupRun(options?)    — testable core (real filesystem, no mocks)
 *   setupCommand(args, context, options?) — AxiCliCommand adapter for the CLI
 */
import { AxiError, installSessionStartHooks } from "axi-sdk-js";
import type { AwsContext } from "../context.js";

export interface SetupRunOptions {
  /** Override the HOME directory — for testing only. */
  readonly homeDir?: string;
  /** Override the executable path — for testing only. */
  readonly execPath?: string;
}

export interface SetupResult {
  readonly hooks: {
    readonly status: "installed";
    readonly integrations: "Claude Code, Codex, OpenCode";
  };
  readonly help: readonly string[];
}

export const SETUP_HELP = `usage: aws-axi setup hooks
Install or repair agent SessionStart hooks for aws-axi ambient context.

Idempotent — safe to re-run. Repairs a stale or incorrect hook path in-place.

Supported agent targets:
  - Claude Code  (~/.claude/settings.json)
  - Codex        (~/.codex/hooks.json + ~/.codex/config.toml)
  - OpenCode     (~/.config/opencode/plugins/)

examples:
  aws-axi setup hooks
`;

/**
 * Core logic — calls installSessionStartHooks and returns a structured result.
 * The homeDir/execPath options exist solely for test isolation (real temp dirs).
 */
export function setupRun(options: SetupRunOptions = {}): SetupResult {
  installSessionStartHooks({
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.execPath !== undefined ? { execPath: options.execPath } : {}),
  });

  return {
    hooks: {
      status: "installed",
      integrations: "Claude Code, Codex, OpenCode",
    },
    help: ["Restart your agent session to receive aws-axi ambient context"],
  };
}

/**
 * AxiCliCommand adapter for `aws-axi setup`.
 * Accepts an optional third argument (SetupRunOptions) for test isolation —
 * in production the CLI calls this with two args only.
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

  return {
    hooks: result.hooks,
    help: [...result.help],
  };
}
