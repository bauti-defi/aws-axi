/**
 * E2E tests for the whoami command through a real stub aws binary.
 * No mocks — the full `awsJson` exec seam runs with a subprocess boundary.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { whoamiRun } from "../src/commands/whoami.js";
import { AxiError } from "axi-sdk-js";

// Absent/empty configPath prevents the NO_PROFILE_SELECTED enrichment from
// reading the developer's real ~/.aws/config in tests.
const EMPTY_CONFIG_PATH = "/nonexistent/path/to/.aws/config";

const tempDirs: string[] = [];

function createStub(spec: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-axi-whoami-"));
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// The fused TOON block (happy path)
// ---------------------------------------------------------------------------

describe("whoamiRun — happy path", () => {
  it("returns the fused identity+context object", async () => {
    // Stub handles both sts get-caller-identity and configure get region
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-whoami-multi-"));
    tempDirs.push(dir);
    const stub = join(dir, "aws");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  sts) printf '%s' '{\"Account\":\"123456789012\",\"UserId\":\"AIDAJQABLCHTEST\",\"Arn\":\"arn:aws:iam::123456789012:user/test-user\"}'; exit 0;;",
        "  configure) printf '%s' 'us-west-2'; exit 0;;",
        "  *) exit 1;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const result = await whoamiRun({
      context: { profile: "my-profile", region: "us-west-2" },
      binary: stub,
    });

    expect(result).toMatchObject({
      whoami: {
        account: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test-user",
        userId: "AIDAJQABLCHTEST",
        profile: "my-profile",
        region: "us-west-2",
      },
    });
  });

  it("falls back to 'default' profile when none specified", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"999999999999","UserId":"AIDATEST","Arn":"arn:aws:iam::999999999999:user/nobody"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: undefined,
      binary: stub,
      configPath: EMPTY_CONFIG_PATH,
    });

    // Profile not specified in context → falls back to "default"
    expect(result.whoami.profile).toBe("default");
  });

  it("includes a credentialSource field", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"123456789012","UserId":"AIDATEST","Arn":"arn:aws:iam::123456789012:user/test"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: { profile: "prod", region: "us-east-1" },
      binary: stub,
    });

    expect(result.whoami.credentialSource).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Credential error paths
// ---------------------------------------------------------------------------

describe("whoamiRun — credential errors", () => {
  it("throws AxiError with NO_CREDENTIALS when no profiles exist in config", async () => {
    // Inject EMPTY_CONFIG_PATH to prevent reading real ~/.aws/config
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    await expect(
      whoamiRun({
        context: undefined,
        binary: stub,
        configPath: EMPTY_CONFIG_PATH,
      }),
    ).rejects.toBeInstanceOf(AxiError);

    const stub2 = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    try {
      await whoamiRun({
        context: undefined,
        binary: stub2,
        configPath: EMPTY_CONFIG_PATH,
      });
    } catch (e) {
      expect((e as AxiError).code).toBe("NO_CREDENTIALS");
      expect(
        (e as AxiError).suggestions.some((s) => s.includes("sso login")),
      ).toBe(true);
    }
  });

  it("throws AxiError with NO_PROFILE_SELECTED when named profiles exist but none selected", async () => {
    const stub = createStub({
      stdout: "",
      stderr: "Unable to locate credentials",
      exitCode: 255,
    });

    // Inject a fake config with named profiles
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-whoami-cfg-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config");
    writeFileSync(configPath, "[profile dev]\n[profile admin]\n[sso-session damm]\n", "utf-8");

    try {
      await whoamiRun({ context: undefined, binary: stub, configPath });
    } catch (e) {
      expect((e as AxiError).code).toBe("NO_PROFILE_SELECTED");
      const allText = `${(e as AxiError).message} ${(e as AxiError).suggestions.join(" ")}`;
      expect(allText).toContain("dev");
      expect(allText).toContain("admin");
      expect(allText).toMatch(/--profile/);
    }
  });

  it("throws AxiError with AUTH_EXPIRED for expired token", async () => {
    const stub = createStub({
      stdout: "",
      stderr:
        "An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: The security token included in the request is expired",
      exitCode: 255,
    });

    try {
      await whoamiRun({
        context: undefined,
        binary: stub,
        configPath: EMPTY_CONFIG_PATH,
      });
    } catch (e) {
      expect((e as AxiError).code).toBe("AUTH_EXPIRED");
      expect(
        (e as AxiError).suggestions.some((s) => s.includes("sso login")),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Region resolution — falls back to aws configure get region
// ---------------------------------------------------------------------------

describe("whoamiRun — region resolution", () => {
  it("reports region from context when supplied", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"123456789012","UserId":"U1","Arn":"arn:aws:iam::123456789012:user/test"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: { profile: "dev", region: "eu-west-1" },
      binary: stub,
    });
    expect(result.whoami.region).toBe("eu-west-1");
  });

  it("falls back to 'aws configure get region' when context has no region", async () => {
    // Multi-dispatch stub: sts → identity JSON, configure → region string
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-whoami-region-"));
    tempDirs.push(dir);
    const stub = join(dir, "aws");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  sts) printf '%s' '{\"Account\":\"123456789012\",\"UserId\":\"U1\",\"Arn\":\"arn:aws:iam::123456789012:user/test\"}'; exit 0;;",
        "  configure) printf '%s' 'us-west-2'; exit 0;;",
        "  *) exit 1;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const result = await whoamiRun({
      context: { profile: "dev", region: undefined },
      binary: stub,
    });
    expect(result.whoami.region).toBe("us-west-2");
  });

  it("degrades to 'unknown' when configure get region fails", async () => {
    // Multi-dispatch stub: sts succeeds, configure fails
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-whoami-noregion-"));
    tempDirs.push(dir);
    const stub = join(dir, "aws");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  sts) printf '%s' '{\"Account\":\"123456789012\",\"UserId\":\"U1\",\"Arn\":\"arn:aws:iam::123456789012:user/test\"}'; exit 0;;",
        "  configure) exit 1;;",
        "  *) exit 1;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const result = await whoamiRun({
      context: { profile: "dev", region: undefined },
      binary: stub,
    });
    expect(result.whoami.region).toBe("unknown");
  });

  it("degrades to 'unknown' when configure returns empty string", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-axi-whoami-emptyregion-"));
    tempDirs.push(dir);
    const stub = join(dir, "aws");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  sts) printf '%s' '{\"Account\":\"123456789012\",\"UserId\":\"U1\",\"Arn\":\"arn:aws:iam::123456789012:user/test\"}'; exit 0;;",
        "  configure) printf '%s' ''; exit 0;;",
        "  *) exit 1;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const result = await whoamiRun({
      context: { profile: "dev", region: undefined },
      binary: stub,
    });
    expect(result.whoami.region).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Profile reporting — whoami must report what was actually used
// ---------------------------------------------------------------------------

describe("whoamiRun — accurate profile reporting", () => {
  it("reports the profile from context (covers AWS_DEFAULT_PROFILE path)", async () => {
    // When context.profile = "admin" (from AWS_DEFAULT_PROFILE resolution),
    // whoami must report "admin", never "default".
    const stub = createStub({
      stdout:
        '{"Account":"465910372065","UserId":"AROAWY6TMC3Q:bauti","Arn":"arn:aws:sts::465910372065:assumed-role/Admin/bauti"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: { profile: "admin", region: "us-west-2" },
      binary: stub,
    });

    expect(result.whoami.profile).toBe("admin");
    expect(result.whoami.credentialSource).toBe("profile:admin");
  });

  it("reports 'default' when no profile is in context (real [default] credential chain)", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"999999999999","UserId":"AIDATEST","Arn":"arn:aws:iam::999999999999:user/nobody"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: undefined,
      binary: stub,
      configPath: EMPTY_CONFIG_PATH,
    });

    expect(result.whoami.profile).toBe("default");
    expect(result.whoami.credentialSource).toBe("default");
  });

  it("credentialSource uses AWS_AXI_PROFILE profile name when context provides it", async () => {
    const stub = createStub({
      stdout:
        '{"Account":"123456789012","UserId":"U1","Arn":"arn:aws:iam::123456789012:user/test"}',
      exitCode: 0,
    });

    const result = await whoamiRun({
      context: { profile: "dev", region: undefined },
      binary: stub,
    });

    expect(result.whoami.profile).toBe("dev");
    expect(result.whoami.credentialSource).toBe("profile:dev");
  });
});
