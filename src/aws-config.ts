/**
 * AWS config file parser — diagnostic use only.
 *
 * Reads ~/.aws/config to discover the available profile names.
 * This is NEVER used to mint or validate credentials — the AWS CLI owns that.
 * It is called only when the AWS CLI returns a no-credentials error and no
 * profile was selected, to produce a better error message that names the
 * profiles the user could pass via --profile.
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
 * Returns [] on any I/O error (missing file, permissions, etc.) — diagnostic
 * reads must never surface filesystem errors to the user.
 *
 * @param configPath - override for testing; defaults to ~/.aws/config
 */
export function readAwsConfigProfiles(configPath?: string): string[] {
  const path = configPath ?? join(homedir(), ".aws", "config");

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
