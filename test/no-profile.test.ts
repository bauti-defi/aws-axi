/**
 * E2E tests for the NO_PROFILE_SELECTED diagnostic path.
 *
 * No mocks — real subprocess boundaries via stub binaries + injected configPath.
 * Tests MUST NOT read the developer's real ~/.aws/config:
 *   - All config reads use the injected configPath in AwsRunOptions.
 *   - Tests that expect NO_CREDENTIALS inject an empty or absent configPath.
 *   - Tests that expect NO_PROFILE_SELECTED inject a configPath with named profiles.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  writeFileSync,
  chmodSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { awsJson, awsExec } from "../src/aws.js";
import { AxiError } from "axi-sdk-js";

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
// Stub factory
// ---------------------------------------------------------------------------

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-noprofile-"));
  tempDirs.push(dir);
  const p = join(dir, "aws");

  function shellQuote(s: string): string {
    return `'${s.replaceAll("'", "'\\''")}'`;
  }

  const lines = [
    "#!/bin/sh",
    spec.stdout !== undefined
      ? `printf '%s' ${shellQuote(spec.stdout)}`
      : "",
    spec.stderr !== undefined
      ? `printf '%s' ${shellQuote(spec.stderr)} >&2`
      : "",
    `exit ${spec.exitCode ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");

  writeFileSync(p, lines);
  chmodSync(p, 0o755);
  return p;
}

function makeConfigFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-cfg-"));
  tempDirs.push(dir);
  const configPath = join(dir, "config");
  writeFileSync(configPath, content, "utf-8");
  return configPath;
}

// ---------------------------------------------------------------------------
// awsJson — NO_PROFILE_SELECTED when no profile + named profiles in config
// ---------------------------------------------------------------------------

describe("awsJson — NO_PROFILE_SELECTED diagnostic", () => {
  it("upgrades NO_CREDENTIALS to NO_PROFILE_SELECTED when named profiles exist", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile(`
[profile dev]
sso_session = damm
[profile admin]
sso_session = damm
[sso-session damm]
`);

    let caught: AxiError | null = null;
    try {
      await awsJson(["sts", "get-caller-identity"], {
        binary,
        context: { profile: undefined, region: undefined },
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught).toBeInstanceOf(AxiError);
    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    // Must list the profiles
    const allText = `${caught?.message ?? ""} ${(caught?.suggestions ?? []).join(" ")}`;
    expect(allText).toContain("dev");
    expect(allText).toContain("admin");
    // Must NOT mention sso-session blocks
    expect(allText).not.toContain("sso-session");
    // Must give actionable advice
    expect(allText).toMatch(/--profile/);
    expect(allText).toMatch(/AWS_PROFILE/);
  });

  it("keeps NO_CREDENTIALS when config is absent (no profiles configured at all)", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    let caught: AxiError | null = null;
    try {
      await awsJson(["sts", "get-caller-identity"], {
        binary,
        context: { profile: undefined, region: undefined },
        configPath: "/nonexistent/path/to/.aws/config",
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught).toBeInstanceOf(AxiError);
    expect(caught?.code).toBe("NO_CREDENTIALS");
    // Must still mention sso login as guidance
    expect((caught?.suggestions ?? []).join(" ")).toContain("sso login");
  });

  it("keeps NO_CREDENTIALS when config exists but has no named profiles", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile(`# empty config\n`);

    let caught: AxiError | null = null;
    try {
      await awsJson(["sts", "get-caller-identity"], {
        binary,
        context: { profile: undefined, region: undefined },
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("NO_CREDENTIALS");
  });

  it("does NOT upgrade when a profile WAS selected (profile in context)", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n[profile admin]\n");

    let caught: AxiError | null = null;
    try {
      await awsJson(["sts", "get-caller-identity"], {
        binary,
        context: { profile: "dev", region: undefined },
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    // Profile was selected — this is a genuine creds problem for that profile,
    // not a selection problem.
    expect(caught?.code).toBe("NO_CREDENTIALS");
  });

  it("does NOT upgrade for AUTH_EXPIRED (non-NO_CREDENTIALS code)", async () => {
    const binary = createStub({
      stdout: "",
      stderr:
        "An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: expired",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n");

    let caught: AxiError | null = null;
    try {
      await awsJson(["sts", "get-caller-identity"], {
        binary,
        context: { profile: undefined, region: undefined },
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("AUTH_EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// awsExec — same enrichment applies
// ---------------------------------------------------------------------------

describe("awsExec — NO_PROFILE_SELECTED diagnostic", () => {
  it("upgrades NO_CREDENTIALS to NO_PROFILE_SELECTED when named profiles exist", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n[profile admin]\n");

    let caught: AxiError | null = null;
    try {
      await awsExec(["s3", "ls"], {
        binary,
        context: { profile: undefined, region: undefined },
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
  });
});

// ---------------------------------------------------------------------------
// Exit code contract
// ---------------------------------------------------------------------------

describe("awsExitCode — NO_PROFILE_SELECTED maps to 253", () => {
  it("NO_PROFILE_SELECTED has exit code 253 (same bucket as NO_CREDENTIALS)", async () => {
    const { awsExitCode } = await import("../src/errors.js");
    expect(awsExitCode("NO_PROFILE_SELECTED")).toBe(253);
  });
});
