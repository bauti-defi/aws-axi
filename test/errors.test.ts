import { describe, it, expect } from "bun:test";
import {
  parseAwsError,
  mapAwsError,
  awsExitCode,
  awsNotInstalledError,
} from "../src/errors.js";
import { AxiError } from "axi-sdk-js";

// Real botocore stderr strings, pinned from aws-cli 2.33.13 output.

describe("parseAwsError — credential errors", () => {
  it("maps 'Unable to locate credentials' to NO_CREDENTIALS", () => {
    const result = parseAwsError(
      "Unable to locate credentials",
      255,
    );
    expect(result.code).toBe("NO_CREDENTIALS");
    expect(result.suggestions.some((s) => s.includes("sso login"))).toBe(true);
  });

  it("maps ExpiredTokenException to AUTH_EXPIRED", () => {
    const result = parseAwsError(
      "An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: The security token included in the request is expired",
      255,
    );
    expect(result.code).toBe("AUTH_EXPIRED");
    expect(result.botoCode).toBe("ExpiredTokenException");
    expect(result.operation).toBe("GetCallerIdentity");
    expect(result.suggestions.some((s) => s.includes("sso login"))).toBe(true);
  });
});

describe("parseAwsError — DryRun success signal", () => {
  it("maps DryRunOperation to DRY_RUN_SUCCESS", () => {
    const result = parseAwsError(
      "An error occurred (DryRunOperation) when calling the RunInstances operation: Request would have succeeded, but DryRun flag is set.",
      255,
    );
    expect(result.code).toBe("DRY_RUN_SUCCESS");
    expect(result.botoCode).toBe("DryRunOperation");
    expect(result.operation).toBe("RunInstances");
  });
});

describe("parseAwsError — service client errors", () => {
  it("maps AccessDenied to SERVICE_CLIENT_ERROR", () => {
    const result = parseAwsError(
      "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: User: arn:aws:iam::123456789012:user/test is not authorized to perform: sts:GetCallerIdentity",
      255,
    );
    expect(result.code).toBe("SERVICE_CLIENT_ERROR");
    expect(result.botoCode).toBe("AccessDenied");
    expect(result.operation).toBe("GetCallerIdentity");
    expect(result.message).toContain("AccessDenied");
  });

  it("maps NoSuchBucket to SERVICE_CLIENT_ERROR", () => {
    const result = parseAwsError(
      "An error occurred (NoSuchBucket) when calling the ListObjects operation: The specified bucket does not exist",
      255,
    );
    expect(result.code).toBe("SERVICE_CLIENT_ERROR");
    expect(result.botoCode).toBe("NoSuchBucket");
  });
});

describe("parseAwsError — aws not installed", () => {
  it("maps ENOENT sentinel to AWS_NOT_INSTALLED", () => {
    const result = parseAwsError("ENOENT", 127);
    expect(result.code).toBe("AWS_NOT_INSTALLED");
    expect(result.message).toContain("aws CLI");
  });
});

describe("parseAwsError — unknown/general errors", () => {
  it("maps unrecognized stderr to UNKNOWN", () => {
    const result = parseAwsError("some random error from aws", 255);
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe("some random error from aws");
  });

  it("uses first line of multi-line stderr", () => {
    const result = parseAwsError("first line\nsecond line\nthird line", 255);
    expect(result.message).toBe("first line");
  });

  it("includes code in message when stderr is empty", () => {
    const result = parseAwsError("", 255);
    expect(result.message).toContain("255");
  });
});

describe("awsExitCode", () => {
  it("returns 252 for USAGE_ERROR", () => {
    expect(awsExitCode("USAGE_ERROR")).toBe(252);
  });

  it("returns 253 for NO_CREDENTIALS", () => {
    expect(awsExitCode("NO_CREDENTIALS")).toBe(253);
  });

  it("returns 253 for AUTH_EXPIRED", () => {
    expect(awsExitCode("AUTH_EXPIRED")).toBe(253);
  });

  it("returns 254 for SERVICE_CLIENT_ERROR", () => {
    expect(awsExitCode("SERVICE_CLIENT_ERROR")).toBe(254);
  });

  it("returns 0 for DRY_RUN_SUCCESS (treat as success)", () => {
    expect(awsExitCode("DRY_RUN_SUCCESS")).toBe(0);
  });

  it("returns 127 for AWS_NOT_INSTALLED", () => {
    expect(awsExitCode("AWS_NOT_INSTALLED")).toBe(127);
  });

  it("returns 255 for UNKNOWN", () => {
    expect(awsExitCode("UNKNOWN")).toBe(255);
  });
});

describe("mapAwsError", () => {
  it("returns an AxiError with correct code and message", () => {
    const err = mapAwsError(
      "An error occurred (AccessDenied) when calling the GetCallerIdentity operation: forbidden",
      255,
    );
    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe("SERVICE_CLIENT_ERROR");
    expect(err.message).toContain("AccessDenied");
  });
});

describe("awsNotInstalledError", () => {
  it("returns AxiError with AWS_NOT_INSTALLED code", () => {
    const err = awsNotInstalledError();
    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe("AWS_NOT_INSTALLED");
    expect(err.message).toContain("aws CLI");
  });
});
