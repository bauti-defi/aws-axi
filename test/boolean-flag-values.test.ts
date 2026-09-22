/**
 * Explicit boolean values on model boolean params must be parsed, not forwarded
 * as stray tokens. Real `aws` rejects `--start-from-head false` with
 * "Unknown options: false" before any API call; aws-axi accepts the agent form
 * and translates it to AWS CLI boolean semantics.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { engineRun, translateBooleanFlags } from "../src/engine.js";
import { releaseStubBins, stubBin, uniqueStubDir } from "./helpers/stub-bin.js";

afterEach(() => {
  releaseStubBins();
});

const USAGE_BANNER =
  "usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]";

/**
 * Child that mimics AWS CLI boolean parsing for GetLogEvents:
 *   --start-from-head / --unmask          → true
 *   --no-start-from-head / --no-unmask    → false
 *   a bare true/false token               → exit 252 Unknown options
 *   --flag=<value> on a boolean           → exit 252 ignored explicit argument
 * Value-taking flags consume the next token so a log group named "false" is
 * not mistaken for an unknown option.
 */
function createBooleanParsingStub(logFile: string): string {
  function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  const script = [
    "#!/bin/sh",
    `log=${shellQuote(logFile)}`,
    "start_from_head=",
    "unmask=",
    "expect_value=",
    "seen_flag=0",
    'for arg in "$@"; do',
    '  if [ "$seen_flag" = "0" ] && [ "${arg#--}" = "$arg" ]; then',
    "    continue",
    "  fi",
    "  seen_flag=1",
    '  if [ -n "$expect_value" ]; then',
    "    printf '%s\\n' \"$expect_value=$arg\" >> \"$log\"",
    "    expect_value=",
    "    continue",
    "  fi",
    '  case "$arg" in',
    "    --start-from-head) start_from_head=true ;;",
    "    --no-start-from-head) start_from_head=false ;;",
    "    --unmask) unmask=true ;;",
    "    --no-unmask) unmask=false ;;",
    "    --start-from-head=*|--unmask=*)",
    `      printf '%s\\n' ${shellQuote(USAGE_BANNER)} >&2`,
    "      printf 'ignored explicit argument: %s\\n' \"$arg\" >&2",
    "      exit 252",
    "      ;;",
    "    --log-group-name|--log-group-identifier|--log-stream-name|--limit|--start-time|--end-time|--next-token|--output|--query|--max-items|--region|--profile)",
    '      expect_value="$arg"',
    "      ;;",
    "    --*) ;;",
    "    *)",
    `      printf '%s\\n' ${shellQuote(USAGE_BANNER)} >&2`,
    "      printf 'Unknown options: %s\\n' \"$arg\" >&2",
    "      exit 252",
    "      ;;",
    "  esac",
    "done",
    'if [ -z "$start_from_head" ]; then start_from_head=false; fi',
    'if [ -z "$unmask" ]; then unmask=false; fi',
    "printf 'startFromHead=%s\\n' \"$start_from_head\" >> \"$log\"",
    "printf 'unmask=%s\\n' \"$unmask\" >> \"$log\"",
    "printf '%s' '{}'",
  ].join("\n");

  return stubBin(script);
}

const STREAM_ARGS = [
  "--log-group-name",
  "example-log-group",
  "--log-stream-name",
  "example-stream",
  "--limit",
  "1",
] as const;

async function runGetLogEvents(
  extraArgs: readonly string[],
  logFile: string,
): Promise<string> {
  const binary = createBooleanParsingStub(logFile);
  await engineRun({
    service: "logs",
    operation: "get-log-events",
    args: [...STREAM_ARGS, ...extraArgs],
    binary,
  });
  return readFileSync(logFile, "utf8");
}

describe("model boolean flags accept an explicit value", () => {
  it("parses --start-from-head false as startFromHead=false without USAGE_ERROR", async () => {
    const logFile = join(uniqueStubDir(), "argv.txt");

    const recorded = await runGetLogEvents(["--start-from-head", "false"], logFile);

    expect(recorded).toContain("startFromHead=false");
    expect(recorded).not.toContain("Unknown options");
    expect(recorded).toContain("--log-stream-name=example-stream");
  });

  it("parses --start-from-head true as startFromHead=true", async () => {
    const logFile = join(uniqueStubDir(), "argv.txt");

    const recorded = await runGetLogEvents(["--start-from-head", "true"], logFile);

    expect(recorded).toContain("startFromHead=true");
  });

  it("parses bare --start-from-head as startFromHead=true", async () => {
    const logFile = join(uniqueStubDir(), "argv.txt");

    const recorded = await runGetLogEvents(["--start-from-head"], logFile);

    expect(recorded).toContain("startFromHead=true");
  });

  it("keeps --no-start-from-head as startFromHead=false", async () => {
    const logFile = join(uniqueStubDir(), "argv.txt");

    const recorded = await runGetLogEvents(["--no-start-from-head"], logFile);

    expect(recorded).toContain("startFromHead=false");
  });

  it("parses --unmask false as unmask=false, not a special case of one flag", async () => {
    const logFile = join(uniqueStubDir(), "argv.txt");

    const recorded = await runGetLogEvents(["--unmask", "false"], logFile);

    expect(recorded).toContain("unmask=false");
    expect(recorded).toContain("startFromHead=false");
  });

  it("does not consume a boolean literal that is the value of a non-boolean flag", async () => {
    const logFile = join(uniqueStubDir(), "argv.txt");
    const binary = createBooleanParsingStub(logFile);

    await engineRun({
      service: "logs",
      operation: "get-log-events",
      args: [
        "--log-group-name",
        "false",
        "--log-stream-name",
        "example-stream",
      ],
      binary,
    });

    const recorded = readFileSync(logFile, "utf8");
    expect(recorded).toContain("--log-group-name=false");
    expect(recorded).toContain("startFromHead=false");
  });

  it("names an unrecognised explicit boolean value instead of forwarding it", async () => {
    const logFile = join(uniqueStubDir(), "argv.txt");
    const binary = createBooleanParsingStub(logFile);

    let thrown: unknown;
    try {
      await engineRun({
        service: "logs",
        operation: "get-log-events",
        args: [
          "--log-stream-name",
          "example-stream",
          "--start-from-head=off",
        ],
        binary,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AxiError);
    if (!(thrown instanceof AxiError)) {
      throw new Error("expected AxiError");
    }
    expect(thrown.code).toBe("USAGE_ERROR");
    expect(thrown.message).toContain("--start-from-head=off");

    // The child must not be the one rejecting the token — aws-axi names it first.
    expect(() => readFileSync(logFile, "utf8")).toThrow();
  });
});

const START_FROM_HEAD = {
  name: "startFromHead",
  type: "boolean",
  required: false,
} as const;

describe("translateBooleanFlags", () => {
  it("parses false, true, and bare --start-from-head", () => {
    expect(
      translateBooleanFlags({
        args: ["--start-from-head", "false"],
        params: [START_FROM_HEAD],
      }).values.startFromHead,
    ).toBe(false);

    expect(
      translateBooleanFlags({
        args: ["--start-from-head", "true"],
        params: [START_FROM_HEAD],
      }).values.startFromHead,
    ).toBe(true);

    expect(
      translateBooleanFlags({
        args: ["--start-from-head"],
        params: [START_FROM_HEAD],
      }).values.startFromHead,
    ).toBe(true);

    expect(
      translateBooleanFlags({
        args: ["--no-start-from-head"],
        params: [START_FROM_HEAD],
      }).values.startFromHead,
    ).toBe(false);
  });

  it("does not forward the literal false token", () => {
    const translated = translateBooleanFlags({
      args: ["--log-stream-name", "example-stream", "--start-from-head", "false"],
      params: [
        START_FROM_HEAD,
        { name: "logStreamName", type: "string", required: true },
      ],
    });

    expect(translated.args).toEqual([
      "--log-stream-name",
      "example-stream",
      "--no-start-from-head",
    ]);
    expect(translated.values.startFromHead).toBe(false);
  });
});
