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
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { awsJson, awsExec } from "../src/aws.js";
import { waitRun } from "../src/commands/wait.js";
import { s3CreateBucketRun } from "../src/commands/s3.js";
import { lambdaRun } from "../src/commands/lambda.js";
import { resolveBucket } from "../src/resolve/bucket.js";
import { AxiError } from "axi-sdk-js";
import { fileURLToPath } from "node:url";
import { stubBin, releaseStubBins } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

/** Botocore fixture data dir for waitRun tests (fake-svc waiter model). */
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures");

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

  const p = stubBin(lines);
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
// awsJson — NO_PROFILE_SELECTED message accuracy (F2)
// ---------------------------------------------------------------------------

describe("awsJson — NO_PROFILE_SELECTED message correctness", () => {
  it("message says 'no [default] profile exists' when [default] is truly absent", async () => {
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
        context: { profile: undefined, region: undefined },
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    expect(caught?.message).toContain("no [default] profile exists");
  });

  it("message says [default] has no credentials when [default] section exists but is credential-less", async () => {
    // A region-only [default] section still counts as "default exists" but
    // has no usable credentials. The message must NOT lie and say it is absent.
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile(
      "[default]\nregion = us-west-2\n[profile dev]\n[profile admin]\n",
    );

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

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    // Must NOT say [default] doesn't exist — it does.
    expect(caught?.message).not.toContain("no [default] profile exists");
    // Must mention [default] in some truthful way
    expect(caught?.message).toMatch(/\[default\]/);
    // Must still list the named profiles
    const allText = `${caught?.message ?? ""} ${(caught?.suggestions ?? []).join(" ")}`;
    expect(allText).toContain("dev");
    expect(allText).toContain("admin");
  });
});

// ---------------------------------------------------------------------------
// buildNoProfileSelectedError — placeholder vs concrete example (B1)
// ---------------------------------------------------------------------------

describe("buildNoProfileSelectedError — suggestion content", () => {
  it("uses <name> placeholder when multiple profiles exist (never guesses)", async () => {
    // Multiple profiles — the tool must not pick an arbitrary one.
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n[profile admin]\n[profile other]\n");

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

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    const suggestions = caught?.suggestions ?? [];
    // Must use the placeholder, never a guessed profile name
    expect(suggestions.some((s) => s.includes("--profile <name>"))).toBe(true);
    expect(suggestions.some((s) => s.includes("export AWS_PROFILE=<name>"))).toBe(true);
    // Must still list all the profiles so the user can choose
    expect(suggestions.some((s) => s.includes("dev") && s.includes("admin"))).toBe(true);
  });

  it("uses the concrete profile name when exactly one profile exists", async () => {
    // Single profile — safe to name it because there is no ambiguity.
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile only-profile]\n");

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

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    const suggestions = caught?.suggestions ?? [];
    expect(suggestions.some((s) => s.includes("--profile only-profile"))).toBe(true);
    expect(suggestions.some((s) => s.includes("export AWS_PROFILE=only-profile"))).toBe(true);
  });
});

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

  it("upgrades to NO_PROFILE_SELECTED when context.profile is empty string (treated as absent)", async () => {
    // An empty-string profile must not bypass enrichment — same as undefined.
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
        context: { profile: "", region: undefined },
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    // Empty-string profile = no profile selected → should upgrade
    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
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

// ---------------------------------------------------------------------------
// awsRaw consumers — enrichment reaches every command surface (#70 gap)
//
// These three tests close the gap identified in cycle-4: wait, s3 create-bucket,
// and resolveBucket called parseAwsError directly off awsRaw results, bypassing
// enrichNoCredsError. They now call parseAndEnrichAwsError, so NO_CREDENTIALS is
// upgraded to NO_PROFILE_SELECTED whenever named profiles exist but none was selected.
// ---------------------------------------------------------------------------

describe("waitRun — NO_PROFILE_SELECTED diagnostic (awsRaw consumer)", () => {
  it("upgrades NO_CREDENTIALS to NO_PROFILE_SELECTED when named profiles exist but none selected", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n[profile admin]\n");

    let caught: AxiError | null = null;
    try {
      await waitRun({
        service: "fake-svc",
        waiterName: "item-ready",
        flags: [],
        binary,
        dataDir: FIXTURES_DIR,
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    const allText = `${caught?.message ?? ""} ${(caught?.suggestions ?? []).join(" ")}`;
    expect(allText).toContain("dev");
    expect(allText).toContain("admin");
  });
});

describe("s3CreateBucketRun — NO_PROFILE_SELECTED diagnostic (awsRaw consumer)", () => {
  it("upgrades NO_CREDENTIALS to NO_PROFILE_SELECTED when named profiles exist but none selected", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n[profile admin]\n");

    let caught: AxiError | null = null;
    try {
      await s3CreateBucketRun({
        bucket: "my-test-bucket",
        // Provide region explicitly so resolveConfigRegion is not called
        // (that path also uses awsRaw; would fail too, but we want one clean stub call).
        region: "us-east-1",
        binary,
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    const allText = `${caught?.message ?? ""} ${(caught?.suggestions ?? []).join(" ")}`;
    expect(allText).toContain("dev");
    expect(allText).toContain("admin");
  });
});

describe("resolveBucket — NO_PROFILE_SELECTED diagnostic (awsRaw consumer)", () => {
  it("upgrades NO_CREDENTIALS to NO_PROFILE_SELECTED when named profiles exist but none selected", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n[profile admin]\n");

    let caught: AxiError | null = null;
    try {
      await resolveBucket({ bucket: "my-test-bucket", binary, configPath });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    const allText = `${caught?.message ?? ""} ${(caught?.suggestions ?? []).join(" ")}`;
    expect(allText).toContain("dev");
    expect(allText).toContain("admin");
  });
});

describe("lambdaRun invoke — NO_PROFILE_SELECTED diagnostic (awsRaw consumer)", () => {
  it("upgrades NO_CREDENTIALS to NO_PROFILE_SELECTED when named profiles exist but none selected", async () => {
    const binary = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });
    const configPath = makeConfigFile("[profile dev]\n[profile admin]\n");

    let caught: AxiError | null = null;
    try {
      await lambdaRun({
        subcommand: "invoke",
        args: ["--function-name", "my-function"],
        binary,
        configPath,
      });
    } catch (e) {
      caught = e as AxiError;
    }

    expect(caught?.code).toBe("NO_PROFILE_SELECTED");
    const allText = `${caught?.message ?? ""} ${(caught?.suggestions ?? []).join(" ")}`;
    expect(allText).toContain("dev");
    expect(allText).toContain("admin");
  });
});
