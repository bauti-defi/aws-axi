/**
 * Exec seam — the single choke point every aws command passes through.
 *
 * Shells out to the real `aws` binary (or a test stub passed as `binary`).
 * Always appends `--output json`; injects profile/region via child-process env
 * so global flags never conflict with operation-level flags.
 *
 * Three surface levels:
 *   awsRaw   — returns ExecResult; never throws (except for ENOENT)
 *   awsExec  — returns raw stdout string; throws AxiError on non-zero exit
 *   awsJson  — parses stdout as JSON; throws AxiError on non-zero exit
 */
import { execFile } from "node:child_process";
import type { AwsContext } from "./context.js";
import { mapAwsError, parseAwsError, AxiError } from "./errors.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface AwsRunOptions {
  /** Override the aws binary path. Defaults to `"aws"`. Used in tests. */
  readonly binary?: string;
  /** Per-call profile/region context injected as child-process env vars. */
  readonly context?: AwsContext;
}

const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

function buildArgs(userArgs: readonly string[]): string[] {
  return [...userArgs, "--output", "json"];
}

function buildChildEnv(context: AwsContext | undefined): Record<string, string | undefined> {
  // Clone current env so the child inherits it; overlay profile/region.
  const env: Record<string, string | undefined> = { ...process.env } as Record<string, string | undefined>;
  if (context?.profile) {
    env["AWS_PROFILE"] = context.profile;
  }
  if (context?.region) {
    env["AWS_DEFAULT_REGION"] = context.region;
    env["AWS_REGION"] = context.region;
  }
  return env;
}

async function run(
  userArgs: readonly string[],
  options: AwsRunOptions,
): Promise<ExecResult> {
  const binary = options.binary ?? "aws";
  const args = buildArgs(userArgs);
  const env = buildChildEnv(options.context);

  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      // encoding: "utf8" selects the string-returning overload of execFile.
      { maxBuffer: MAX_BUFFER_BYTES, env, encoding: "utf8" as const },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          // Resolve with sentinel — callers check and throw AWS_NOT_INSTALLED.
          resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
          return;
        }
        const code = error
          ? ((error as Error & { code?: string | number }).code ?? 1)
          : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof code === "number" ? code : 1,
        });
      },
    );
  });
}

/**
 * Execute aws and return the raw ExecResult.
 * Throws AxiError only for ENOENT (aws not installed).
 */
export async function awsRaw(
  args: readonly string[],
  options: AwsRunOptions = {},
): Promise<ExecResult> {
  const result = await run(args, options);
  if (result.stderr === "ENOENT") {
    throw mapAwsError("ENOENT", 127);
  }
  return result;
}

/**
 * Execute aws and return raw stdout string.
 * Throws AxiError on non-zero exit or ENOENT.
 */
export async function awsExec(
  args: readonly string[],
  options: AwsRunOptions = {},
): Promise<string> {
  const result = await run(args, options);
  if (result.stderr === "ENOENT") {
    throw mapAwsError("ENOENT", 127);
  }
  if (result.exitCode !== 0) {
    throw mapAwsError(result.stderr, result.exitCode);
  }
  return result.stdout;
}

/**
 * Execute aws and return parsed JSON.
 * DryRunOperation is treated as success and returns `{}`.
 * Throws AxiError on any other non-zero exit or ENOENT.
 */
export async function awsJson<T = unknown>(
  args: readonly string[],
  options: AwsRunOptions = {},
): Promise<T> {
  const result = await run(args, options);

  if (result.stderr === "ENOENT") {
    throw mapAwsError("ENOENT", 127);
  }

  if (result.exitCode !== 0) {
    const parsed = parseAwsError(result.stderr, result.exitCode);
    if (parsed.code === "DRY_RUN_SUCCESS") {
      return {} as T;
    }
    throw new AxiError(parsed.message, parsed.code, [...parsed.suggestions]);
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new AxiError(
      `Unexpected aws output: ${result.stdout.slice(0, 200)}`,
      "UNKNOWN",
    );
  }
}
