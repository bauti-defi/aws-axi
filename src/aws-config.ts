/**
 * AWS config file parser — diagnostic and telemetry use only.
 *
 * Reads ~/.aws/config to:
 *   1. Discover the available profile names (for NO_PROFILE_SELECTED diagnostics).
 *   2. Read a profile's configured region (for whoami — avoids an extra subprocess).
 *
 * This is NEVER used to mint or validate credentials — the AWS CLI owns that.
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

/**
 * Read the region configured for a specific profile in ~/.aws/config.
 *
 * Used by whoami to resolve region without an extra `aws configure get`
 * subprocess — a few-ms file read vs ~500ms of Python AWS CLI startup.
 *
 * Resolution order for the config file path follows AWS_CONFIG_FILE / default,
 * same as readAwsConfigProfiles.
 *
 * Returns undefined if the profile section is absent, or if it has no `region`
 * key. Callers should fall back to "unknown" in that case.
 *
 * Never throws — FS errors degrade silently.
 *
 * @param profile     - profile name ("default" for [default], "dev" for [profile dev])
 * @param configPath  - override for testing; takes precedence over AWS_CONFIG_FILE
 */
export function readConfigProfileRegion(profile: string, configPath?: string): string | undefined {
  const path = configPath ?? process.env["AWS_CONFIG_FILE"] ?? join(homedir(), ".aws", "config");

  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const content = readFileSync(path, "utf-8");
    // The section header for the target profile:
    //   "default"     → [default]
    //   any other     → [profile <name>]
    const targetHeader = profile === "default" ? "[default]" : `[profile ${profile}]`;
    let inSection = false;

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();

      // Skip blank lines and comments
      if (line === "" || line.startsWith("#") || line.startsWith(";")) {
        continue;
      }

      if (line.startsWith("[")) {
        // New section — check if it's our target
        inSection = line === targetHeader;
        continue;
      }

      if (inSection) {
        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
          const key = line.slice(0, eqIdx).trim();
          const val = line.slice(eqIdx + 1).trim();
          if (key === "region" && val) {
            return val;
          }
        }
      }
    }
  } catch {
    // Swallow FS errors — telemetry path must not throw
  }

  return undefined;
}
