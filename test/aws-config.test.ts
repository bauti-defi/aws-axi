/**
 * Unit tests for the AWS config INI parser.
 *
 * parseAwsConfigProfiles is pure — no file I/O, fully deterministic.
 * readAwsConfigProfiles exercises the FS path with an injected configPath
 * so it never touches the developer's real ~/.aws/config.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAwsConfigProfiles, readAwsConfigProfiles } from "../src/aws-config.js";

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
// parseAwsConfigProfiles — pure INI parser
// ---------------------------------------------------------------------------

describe("parseAwsConfigProfiles — section header recognition", () => {
  it("returns [] for empty content", () => {
    expect(parseAwsConfigProfiles("")).toEqual([]);
  });

  it("returns ['default'] for [default] only", () => {
    expect(parseAwsConfigProfiles("[default]\nregion = us-east-1\n")).toEqual(["default"]);
  });

  it("extracts [profile x] as 'x'", () => {
    expect(parseAwsConfigProfiles("[profile dev]\n")).toEqual(["dev"]);
  });

  it("extracts multiple named profiles in order", () => {
    const content = `
[profile dev]
sso_session = damm
[profile admin]
sso_session = damm
[profile kleros-mm-dev]
sso_session = damm
`;
    expect(parseAwsConfigProfiles(content)).toEqual(["dev", "admin", "kleros-mm-dev"]);
  });

  it("skips [sso-session ...] blocks entirely", () => {
    const content = `
[sso-session damm]
sso_start_url = https://example.com
[profile dev]
sso_session = damm
[sso-session monte]
sso_start_url = https://other.com
`;
    expect(parseAwsConfigProfiles(content)).toEqual(["dev"]);
  });

  it("includes [default] alongside named profiles", () => {
    const content = `
[default]
region = us-west-2
[profile dev]
sso_session = damm
[profile admin]
sso_session = damm
`;
    expect(parseAwsConfigProfiles(content)).toEqual(["default", "dev", "admin"]);
  });

  it("skips unknown section types (e.g. [services])", () => {
    const content = `
[services]
some_service = my-endpoint-config
[profile dev]
`;
    expect(parseAwsConfigProfiles(content)).toEqual(["dev"]);
  });
});

describe("parseAwsConfigProfiles — comments and whitespace", () => {
  it("ignores lines starting with #", () => {
    const content = `# This is a comment
[profile dev]
# another comment
region = us-west-2
`;
    expect(parseAwsConfigProfiles(content)).toEqual(["dev"]);
  });

  it("ignores lines starting with ;", () => {
    const content = `; semicolon comment
[profile dev]
`;
    expect(parseAwsConfigProfiles(content)).toEqual(["dev"]);
  });

  it("ignores blank lines", () => {
    const content = `

[profile dev]

[profile admin]

`;
    expect(parseAwsConfigProfiles(content)).toEqual(["dev", "admin"]);
  });

  it("trims leading/trailing whitespace on section headers", () => {
    // Unusual but valid INI: spaces inside brackets after trimming
    const content = `  [profile dev]  \n`;
    expect(parseAwsConfigProfiles(content)).toEqual(["dev"]);
  });
});

describe("parseAwsConfigProfiles — CRLF line endings", () => {
  it("handles \\r\\n line endings", () => {
    const content = "[profile dev]\r\nregion = us-west-2\r\n[profile admin]\r\n";
    expect(parseAwsConfigProfiles(content)).toEqual(["dev", "admin"]);
  });
});

describe("parseAwsConfigProfiles — realistic ~/.aws/config layout", () => {
  it("parses the exact layout from the issue (5 sections, 2 sso-session blocks)", () => {
    const content = `[profile personal]
region = us-west-2

[sso-session example]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile dev]
sso_session = example
sso_account_id = 123456789012
sso_role_name = ExampleDeveloper

[profile admin]
sso_session = example
sso_account_id = 123456789012
sso_role_name = ExampleAdmin

[sso-session example2]
sso_start_url = https://example2.awsapps.com/start
sso_region = us-east-1

[profile monte]
sso_session = example2

[profile kleros-mm-dev]
sso_session = example
`;
    expect(parseAwsConfigProfiles(content)).toEqual([
      "personal",
      "dev",
      "admin",
      "monte",
      "kleros-mm-dev",
    ]);
  });
});

// ---------------------------------------------------------------------------
// readAwsConfigProfiles — FS reader with injected configPath
// ---------------------------------------------------------------------------

describe("readAwsConfigProfiles — file I/O via injected configPath", () => {
  it("returns [] when configPath does not exist", () => {
    expect(readAwsConfigProfiles("/nonexistent/path/to/.aws/config")).toEqual([]);
  });

  it("returns profiles from an injected fake config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-cfg-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config");
    writeFileSync(
      configPath,
      `[profile dev]\n[profile admin]\n[sso-session damm]\n`,
      "utf-8",
    );
    expect(readAwsConfigProfiles(configPath)).toEqual(["dev", "admin"]);
  });

  it("returns [] for an empty config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-cfg-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config");
    writeFileSync(configPath, "", "utf-8");
    expect(readAwsConfigProfiles(configPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readAwsConfigProfiles — AWS_CONFIG_FILE environment variable (F4)
// ---------------------------------------------------------------------------

describe("readAwsConfigProfiles — AWS_CONFIG_FILE env override", () => {
  let savedConfigFile: string | undefined;

  afterEach(() => {
    if (savedConfigFile === undefined) {
      delete process.env["AWS_CONFIG_FILE"];
    } else {
      process.env["AWS_CONFIG_FILE"] = savedConfigFile;
    }
  });

  it("reads from AWS_CONFIG_FILE when set and no explicit configPath given", () => {
    savedConfigFile = process.env["AWS_CONFIG_FILE"];
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-cfg-"));
    tempDirs.push(dir);
    const altPath = join(dir, "alt-config");
    writeFileSync(altPath, "[profile via-env-var]\n[profile also-via-env]\n", "utf-8");

    process.env["AWS_CONFIG_FILE"] = altPath;
    // No explicit configPath — must fall back to AWS_CONFIG_FILE
    expect(readAwsConfigProfiles()).toEqual(["via-env-var", "also-via-env"]);
  });

  it("explicit configPath overrides AWS_CONFIG_FILE", () => {
    savedConfigFile = process.env["AWS_CONFIG_FILE"];
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-cfg-"));
    tempDirs.push(dir);
    const envPath = join(dir, "env-config");
    const explicitPath = join(dir, "explicit-config");
    writeFileSync(envPath, "[profile from-env]\n", "utf-8");
    writeFileSync(explicitPath, "[profile from-explicit]\n", "utf-8");

    process.env["AWS_CONFIG_FILE"] = envPath;
    // Explicit configPath wins over AWS_CONFIG_FILE
    expect(readAwsConfigProfiles(explicitPath)).toEqual(["from-explicit"]);
  });
});

