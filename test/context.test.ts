/**
 * Unit tests for context resolution (profile / region precedence).
 *
 * All env-var tests save and restore the env so they don't bleed into each other.
 * stripContextArgs is a pure function of args + process.env — no I/O.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { stripContextArgs } from "../src/context.js";

// Env vars we touch in tests — restored in afterEach.
const ENV_KEYS = [
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_AXI_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

type SavedEnv = Record<string, string | undefined>;

function saveEnv(): SavedEnv {
  const saved: SavedEnv = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

let savedEnv: SavedEnv = {};

afterEach(() => {
  restoreEnv(savedEnv);
  savedEnv = {};
});

// ---------------------------------------------------------------------------
// Profile precedence: --profile > AWS_PROFILE > AWS_DEFAULT_PROFILE > AWS_AXI_PROFILE
// ---------------------------------------------------------------------------

describe("profile precedence", () => {
  it("--profile flag wins over all env vars", () => {
    savedEnv = saveEnv();
    process.env["AWS_PROFILE"] = "from-aws-profile";
    process.env["AWS_DEFAULT_PROFILE"] = "from-default-profile";
    process.env["AWS_AXI_PROFILE"] = "from-axi-profile";

    const { context } = stripContextArgs(["whoami", "--profile", "from-flag"]);
    expect(context.profile).toBe("from-flag");
  });

  it("AWS_PROFILE wins over AWS_DEFAULT_PROFILE and AWS_AXI_PROFILE when no flag", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    process.env["AWS_PROFILE"] = "aws-profile-value";
    process.env["AWS_DEFAULT_PROFILE"] = "default-profile-value";
    process.env["AWS_AXI_PROFILE"] = "axi-profile-value";

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBe("aws-profile-value");
  });

  it("AWS_DEFAULT_PROFILE wins over AWS_AXI_PROFILE when AWS_PROFILE is absent", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    process.env["AWS_DEFAULT_PROFILE"] = "default-profile-value";
    process.env["AWS_AXI_PROFILE"] = "axi-profile-value";

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBe("default-profile-value");
  });

  it("AWS_AXI_PROFILE is used as last resort when no flag and no other AWS env vars", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    delete process.env["AWS_DEFAULT_PROFILE"];
    process.env["AWS_AXI_PROFILE"] = "axi-only";

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBe("axi-only");
  });

  it("profile is undefined when no flag and no env vars", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    delete process.env["AWS_DEFAULT_PROFILE"];
    delete process.env["AWS_AXI_PROFILE"];

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBeUndefined();
  });

  it("--profile=value= syntax parses correctly", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    delete process.env["AWS_DEFAULT_PROFILE"];
    delete process.env["AWS_AXI_PROFILE"];

    const { context } = stripContextArgs(["whoami", "--profile=my-profile"]);
    expect(context.profile).toBe("my-profile");
  });
});

// ---------------------------------------------------------------------------
// Empty-string env vars — must be treated as unset (F1)
// ---------------------------------------------------------------------------

describe("profile precedence — empty-string env vars treated as absent", () => {
  it("empty AWS_PROFILE falls through to AWS_AXI_PROFILE", () => {
    savedEnv = saveEnv();
    process.env["AWS_PROFILE"] = "";
    delete process.env["AWS_DEFAULT_PROFILE"];
    process.env["AWS_AXI_PROFILE"] = "axi-fallback";

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBe("axi-fallback");
  });

  it("whitespace-only AWS_PROFILE falls through to AWS_AXI_PROFILE", () => {
    savedEnv = saveEnv();
    process.env["AWS_PROFILE"] = "   ";
    delete process.env["AWS_DEFAULT_PROFILE"];
    process.env["AWS_AXI_PROFILE"] = "axi-fallback";

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBe("axi-fallback");
  });

  it("empty AWS_PROFILE and empty AWS_DEFAULT_PROFILE fall through to AWS_AXI_PROFILE", () => {
    savedEnv = saveEnv();
    process.env["AWS_PROFILE"] = "";
    process.env["AWS_DEFAULT_PROFILE"] = "";
    process.env["AWS_AXI_PROFILE"] = "axi-only";

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBe("axi-only");
  });

  it("all empty env vars yield undefined profile", () => {
    savedEnv = saveEnv();
    process.env["AWS_PROFILE"] = "";
    process.env["AWS_DEFAULT_PROFILE"] = "";
    process.env["AWS_AXI_PROFILE"] = "";

    const { context } = stripContextArgs(["whoami"]);
    expect(context.profile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Region precedence (unchanged, regression guard)
// ---------------------------------------------------------------------------

describe("region precedence — regression guard", () => {
  it("--region flag wins", () => {
    savedEnv = saveEnv();
    process.env["AWS_REGION"] = "from-env";
    const { context } = stripContextArgs(["whoami", "--region", "eu-west-1"]);
    expect(context.region).toBe("eu-west-1");
  });

  it("AWS_REGION is used when no --region flag", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "us-east-1";
    delete process.env["AWS_DEFAULT_REGION"];

    const { context } = stripContextArgs(["whoami"]);
    expect(context.region).toBe("us-east-1");
  });

  it("region is undefined when no flag and no env", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_REGION"];
    delete process.env["AWS_DEFAULT_REGION"];

    const { context } = stripContextArgs(["whoami"]);
    expect(context.region).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stripped args — flags are removed from the returned array
// ---------------------------------------------------------------------------

describe("strippedArgs", () => {
  it("removes --profile and its value", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    delete process.env["AWS_DEFAULT_PROFILE"];
    delete process.env["AWS_AXI_PROFILE"];

    const { strippedArgs } = stripContextArgs(["--profile", "dev", "whoami"]);
    expect(strippedArgs).toEqual(["whoami"]);
  });

  it("removes --profile=value", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    delete process.env["AWS_DEFAULT_PROFILE"];
    delete process.env["AWS_AXI_PROFILE"];

    const { strippedArgs } = stripContextArgs(["--profile=dev", "whoami"]);
    expect(strippedArgs).toEqual(["whoami"]);
  });

  it("leaves other args intact", () => {
    savedEnv = saveEnv();
    delete process.env["AWS_PROFILE"];
    delete process.env["AWS_DEFAULT_PROFILE"];
    delete process.env["AWS_AXI_PROFILE"];

    const { strippedArgs } = stripContextArgs([
      "--profile", "dev",
      "ec2", "describe-instances", "--filters", "Name=foo,Values=bar",
    ]);
    expect(strippedArgs).toEqual(["ec2", "describe-instances", "--filters", "Name=foo,Values=bar"]);
  });
});
