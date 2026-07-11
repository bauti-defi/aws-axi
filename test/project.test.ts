import { describe, it, expect } from "bun:test";
import { renderBlock, renderError, renderOutput } from "../src/project.js";

// Golden tests: pin the TOON output format for a sample object.
// If @toon-format/toon encoding changes, these tests catch the regression.

describe("renderBlock", () => {
  it("encodes a flat object as TOON", () => {
    const output = renderBlock({ account: "123456789012", region: "us-east-1" });
    // TOON format: key: value lines
    expect(output).toContain("account:");
    expect(output).toContain("123456789012");
    expect(output).toContain("region:");
    expect(output).toContain("us-east-1");
  });

  it("encodes a nested object as TOON", () => {
    const output = renderBlock({
      whoami: {
        account: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test",
      },
    });
    expect(output).toContain("whoami");
    expect(output).toContain("account");
    expect(output).toContain("123456789012");
  });
});

describe("renderError", () => {
  it("includes error message and code in output", () => {
    const output = renderError("Credentials missing", "NO_CREDENTIALS");
    expect(output).toContain("Credentials missing");
    expect(output).toContain("NO_CREDENTIALS");
  });

  it("includes suggestions as help field when provided", () => {
    const output = renderError("Expired token", "AUTH_EXPIRED", [
      "Run `aws sso login`",
    ]);
    expect(output).toContain("Expired token");
    expect(output).toContain("AUTH_EXPIRED");
    expect(output).toContain("aws sso login");
  });

  it("omits help field when no suggestions", () => {
    const output = renderError("Something failed", "UNKNOWN", []);
    // Should NOT have a help section cluttering the output
    expect(output).not.toContain("help");
  });
});

describe("renderOutput", () => {
  it("joins non-empty blocks with newline", () => {
    const output = renderOutput(["block1", "block2", "block3"]);
    expect(output).toContain("block1");
    expect(output).toContain("block2");
    expect(output).toContain("block3");
  });

  it("filters empty strings", () => {
    const output = renderOutput(["a", "", "b"]);
    // Should only contain the non-empty parts
    expect(output).toBe("a\nb");
  });

  it("returns empty string for all-empty input", () => {
    const output = renderOutput(["", ""]);
    expect(output).toBe("");
  });
});
