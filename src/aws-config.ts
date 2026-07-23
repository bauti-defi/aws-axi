/**
 * AWS config file parser — diagnostics only.
 *
 * Reads ~/.aws/config exclusively to discover available profile names so that
 * a `NO_PROFILE_SELECTED` error can list them. This is the only permitted use
 * of local config-file parsing in aws-axi (see ADR-0003).
 *
 * Any value aws-axi *reports* as fact about the session (profile, region,
 * credential source) must come from the `aws` CLI — never from an independent
 * re-parse of AWS config files.
 *
 * configPath is injectable so tests can point at a fake file without touching
 * the developer's real ~/.aws/config.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Parse raw AWS config INI content and return the list of profile names.
 *
 * Section header rules:
 *   [default]      → "default"
 *   [profile x]    → "x"
 *   [sso-session y] → skipped (not a credential profile)
 *   anything else  → skipped
 *
 * Comments (#, ;) and blank lines are skipped.
 * Handles both LF and CRLF line endings.
 *
 * This is a pure function — exported for testing without file I/O.
 */
export function parseAwsConfigProfiles(content: string): string[] {
  const profiles: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    // Only section headers matter for profile discovery
    if (!line.startsWith("[") || !line.endsWith("]")) {
      continue;
    }

    const inner = line.slice(1, -1).trim();

    if (inner === "default") {
      profiles.push("default");
    } else if (inner.startsWith("profile ")) {
      const name = inner.slice("profile ".length).trim();
      if (name) {
        profiles.push(name);
      }
    }
    // [sso-session ...] and any other section type → skip
  }

  return profiles;
}

/**
 * Read ~/.aws/config (or an injected path) and return the list of profile names.
 *
 * Resolution order for the config file path:
 *   1. `configPath` argument (injectable for tests)
 *   2. `AWS_CONFIG_FILE` environment variable (mirrors the real aws CLI)
 *   3. `~/.aws/config` (default)
 *
 * Returns [] on any I/O error (missing file, permissions, etc.) — diagnostic
 * reads must never surface filesystem errors to the user.
 *
 * @param configPath - override for testing; takes precedence over AWS_CONFIG_FILE
 */
export function readAwsConfigProfiles(configPath?: string): string[] {
  const path = configPath ?? process.env["AWS_CONFIG_FILE"] ?? join(homedir(), ".aws", "config");

  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, "utf-8");
    return parseAwsConfigProfiles(content);
  } catch {
    // Swallow FS errors — diagnostic path must not throw
    return [];
  }
}

