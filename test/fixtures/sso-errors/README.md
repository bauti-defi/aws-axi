# SSO Error Fixtures

Verbatim stderr captured from `aws-cli/2.33.13 Python/3.13.11 Darwin/25.2.0 exe/arm64`
running `aws sts get-caller-identity --output json --profile <name>` against an isolated
`AWS_CONFIG_FILE` + `HOME` (no real `~/.aws` was read or mutated).

Capture method: `AWS_CONFIG_FILE=<tmp> HOME=<tmp> aws sts get-caller-identity ... 2>/file.txt`

**Files are BYTE-EXACT.** Every aws stderr begins with a leading `\n` (blank line before the
error text); the captures include it. Do NOT strip the leading `\n` when updating fixtures —
production (src/aws.ts) passes stderr untrimmed to parseAwsError, and the normalization in
parseAwsError handles it.

Files ending in `-prefixed-2.34.txt` simulate `aws-cli >= 2.34.0` output, which prefixes
`aws: [ERROR]: ` before the error text. These were derived from the 2.33.x captures.

Exit code for all: **255** from the real `aws` binary.
After fix, `parseAwsError(content, 255)` maps all to **AUTH_EXPIRED** (exit 253 from aws-axi).

## Files

| File | Scenario | cli version |
|---|---|---|
| `new-sso-session-no-cache.txt` | `[sso-session]` configured, no cached token | 2.33.13 |
| `new-sso-session-expired.txt` | `[sso-session]` configured, token `expiresAt` in past | 2.33.13 |
| `new-sso-session-invalid-token.txt` | `[sso-session]` configured, token missing required fields | 2.33.13 |
| `legacy-sso-no-cache.txt` | legacy `[profile]` with `sso_*` keys, no cached token | 2.33.13 |
| `legacy-sso-expired.txt` | legacy `[profile]` with `sso_*` keys, token expired | 2.33.13 |
| `new-sso-session-no-cache-prefixed-2.34.txt` | same as above but with `aws: [ERROR]: ` prefix | >= 2.34.0 |
| `new-sso-session-expired-prefixed-2.34.txt` | same as above but with `aws: [ERROR]: ` prefix | >= 2.34.0 |
| `new-sso-session-invalid-token-prefixed-2.34.txt` | same as above but with `aws: [ERROR]: ` prefix | >= 2.34.0 |
| `legacy-sso-no-cache-prefixed-2.34.txt` | same as above but with `aws: [ERROR]: ` prefix | >= 2.34.0 |
| `legacy-sso-expired-prefixed-2.34.txt` | same as above but with `aws: [ERROR]: ` prefix | >= 2.34.0 |

## Config used for 2.33.x captures

New sso-session format:
```ini
[sso-session damm-sso]
sso_start_url = https://damm-test.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile test-profile]
sso_session = damm-sso
sso_account_id = 123456789012
sso_role_name = TestRole
region = us-west-2
```

Legacy sso format (no sso-session stanza):
```ini
[profile legacy-profile]
sso_start_url = https://damm-test.awsapps.com/start
sso_region = us-east-1
sso_account_id = 123456789012
sso_role_name = TestRole
region = us-west-2
```
