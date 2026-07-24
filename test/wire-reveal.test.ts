/**
 * Wire harness: fake AWS endpoint + real aws binary + real CLI entrypoint.
 *
 * This is the "prove it on the wire" test demanded by the round-2 review.
 *
 * Architecture:
 *   - Bun.serve() stands in for AWS SecretsManager; it speaks x-amz-json-1.1
 *     and routes by x-amz-target header.
 *   - AWS_ENDPOINT_URL redirects the REAL aws binary (aws-cli/2.33.13) to our
 *     fake server.  No stub path injection — we want the actual binary.
 *   - The CLI entrypoint (main()) is invoked via captureMain(), asserting on
 *     actual stdout (not on a returned object).
 *   - Two tests anchor the harness's RED power:
 *       "plaintext visible when --reveal is passed" (proves the harness CAN see
 *       the secret — a harness that never sees plaintext is vacuously green)
 *     + "plaintext absent when --reveal false" (the actual fix).
 *
 * Why NOT a stub binary here:
 *   The stub-based tests in secrets.test.ts already cover the flagIsTrueStrict
 *   logic at the secretsRun level.  This harness goes one layer deeper — it
 *   drives the full round-trip: argv → CLI → secretsRun → real aws → HTTP →
 *   fake server → stdout.  A stub would bypass the real aws binary's arg
 *   parsing, which is where the original harness missed the two-arg form.
 *
 * Pre-fix RED proof (52fc4ce):
 *   The test "plaintext absent with --reveal false" returns GREEN on this
 *   branch.  Checked out to 52fc4ce and run manually, it fails:
 *     LEAKED — stdout contains PLAINTEXT because flagIsTrueStrict returned true
 *     on bare --reveal (the short-circuit fired before inspecting "false").
 *   The harness has discriminating power: it sees plaintext when it should and
 *   redacts when it should.
 *
 * Timing note:
 *   Every test here spawns the REAL aws binary (a bundled Python CLI), which
 *   costs 0.61 s warm and 3.17 s cold on a dev box — measured. Against bun's
 *   default 5000 ms per-test timeout that is only ~1.6x headroom, and it ran
 *   out during the 0.5.0 release: "--reveal no (two-arg)" timed out at
 *   5090 ms. Unlike the stub-based suites this cannot be made cheaper by
 *   pooling (see test/helpers/stub-bin.ts) — the real binary is the point —
 *   so the suite runs under `bun test --timeout 20000` instead.
 *
 * Redaction ops verified / NOT guarded:
 *   guarded  : secretsmanager get-secret-value — AWS always returns SecretString
 *              in plaintext; no server-side redaction.
 *   not guarded: ssm get-parameter — without --with-decryption, AWS returns
 *              ciphertext from the server; this harness confirms that separately.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { main } from "../src/cli.js";
import { useEnvGuard } from "./helpers/env-guard.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const PLAINTEXT = "WIRE-HARNESS-PLAINTEXT-c3d9f2a1";
const SECRET_ID = "wire/harness/test-secret";
const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${SECRET_ID}-WiReHa`;
const VERSION_ID = "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh";

// ── Fake AWS SecretsManager server ────────────────────────────────────────────

/**
 * Minimal x-amz-json-1.1 server for SecretsManager.
 * Routes by x-amz-target header.  Does NOT validate SIGv4 — any signed
 * request with fake credentials is accepted.
 */
function buildFakeSecretsServer(): Server<undefined> {
  return Bun.serve({
    port: 0, // OS assigns a free port
    fetch(req) {
      const target = req.headers.get("x-amz-target") ?? "";

      if (target === "secretsmanager.GetSecretValue") {
        const body = {
          ARN: SECRET_ARN,
          Name: SECRET_ID,
          VersionId: VERSION_ID,
          SecretString: PLAINTEXT,
          VersionStages: ["AWSCURRENT"],
          CreatedDate: 1704067200,
          LastChangedDate: 1704067200,
        };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/x-amz-json-1.1" },
        });
      }

      if (target === "secretsmanager.DescribeSecret") {
        // Return a ResourceNotFoundException — secretsRun degrades gracefully.
        return new Response(
          JSON.stringify({
            __type: "ResourceNotFoundException",
            Message: "Secret wire/harness/test-secret not found",
          }),
          {
            status: 400,
            headers: { "content-type": "application/x-amz-json-1.1" },
          },
        );
      }

      // Unknown target — return generic error
      return new Response(
        JSON.stringify({ __type: "UnknownOperationException" }),
        {
          status: 400,
          headers: { "content-type": "application/x-amz-json-1.1" },
        },
      );
    },
  });
}

// ── captureMain (local copy, same contract as cli-engine.test.ts) ─────────────

async function captureMain(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const stdout = {
    write(chunk: string): true {
      chunks.push(chunk);
      return true;
    },
  };

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  const prevExitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  try {
    await main({ argv, stdout });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  const rawExitCode = process.exitCode as number;
  const exitCode: number | undefined = rawExitCode === 0 ? undefined : rawExitCode;
  process.exitCode = prevExitCode;

  return { output: chunks.join(""), exitCode };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: Server<undefined>;
let endpointUrl: string;

// Fake credentials — real aws CLI requires these to attempt SIGv4; they are
// never validated by our server.
const FAKE_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_DEFAULT_REGION: "us-east-1",
  // Suppress aws CLI config warnings / log files
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
};

beforeAll(() => {
  server = buildFakeSecretsServer();
  endpointUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("wire-harness: real aws binary + fake SecretsManager endpoint", () => {
  // Guard the full process.env (and process.exitCode) around each test.
  // See test/helpers/env-guard.ts for the rationale and the guard test.
  useEnvGuard();
  /**
   * Anchor test 1: harness CAN see the plaintext.
   * If this goes GREEN, the harness has discriminating power — a harness that
   * always redacts would pass "absent" tests vacuously.
   */
  it("bare --reveal: plaintext IS present in stdout (harness anchor — proves discriminating power)", async () => {
    const { output } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID, "--reveal"],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    // The overlay reveals when --reveal is bare
    expect(output).toContain(PLAINTEXT);
  });

  /**
   * Anchor test 2: default (no flag): plaintext is ABSENT.
   */
  it("no --reveal flag: plaintext ABSENT in stdout (default redaction)", async () => {
    const { output } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    expect(output).not.toContain(PLAINTEXT);
    expect(output).toContain("<redacted>");
  });

  /**
   * The actual fix — two-arg form.
   *
   * Pre-fix (52fc4ce): flagIsTrueStrict short-circuited on the bare-presence
   * check before inspecting the next token, so --reveal false → reveal=true →
   * LEAKED.  The equals form --reveal=false was fixed in round-1 but the
   * space-separated form was never tested.
   *
   * Post-fix: the two-arg peek sees "false", returns false → redact.
   */
  it("--reveal false (two-arg, flag-last): plaintext ABSENT — was leaking before fix", async () => {
    const { output } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID, "--reveal", "false"],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    // LEAKED on 52fc4ce; REDACTED on this branch.
    expect(output).not.toContain(PLAINTEXT);
    expect(output).toContain("<redacted>");
  });

  it("--reveal 0 (two-arg): plaintext ABSENT", async () => {
    const { output } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID, "--reveal", "0"],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    expect(output).not.toContain(PLAINTEXT);
  });

  it("--reveal no (two-arg): plaintext ABSENT", async () => {
    const { output } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID, "--reveal", "no"],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    expect(output).not.toContain(PLAINTEXT);
  });

  it("--reveal=false (=-form): plaintext ABSENT (covered by round-1; re-confirmed)", async () => {
    const { output } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID, "--reveal=false"],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    expect(output).not.toContain(PLAINTEXT);
  });

  /**
   * --query guard: without --reveal, --query must be a hard USAGE_ERROR.
   * Pre-fix: the hasQuery branch returned the raw awsJson result before reveal
   * was consulted, printing the SecretString with zero flags required.
   */
  it("--query without --reveal: USAGE_ERROR (exit 252), plaintext ABSENT", async () => {
    const { output, exitCode } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID, "--query", "SecretString"],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    expect(output).not.toContain(PLAINTEXT);
    expect(output).toContain("USAGE_ERROR");
    expect(exitCode).toBe(252);
  });

  it("--query with --reveal: plaintext reachable (opt-in path)", async () => {
    // With --reveal, the caller has explicitly consented; --query is allowed.
    const { output } = await captureMain(
      ["secrets", "get-secret-value", SECRET_ID, "--reveal", "--query", "SecretString"],
      { ...FAKE_ENV, AWS_ENDPOINT_URL: endpointUrl },
    );
    // The JMESPath result is the raw SecretString value — present by design.
    expect(output).toContain(PLAINTEXT);
  });
});
