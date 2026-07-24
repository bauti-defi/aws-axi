# SSO Error Fixtures

Verbatim stderr captured from `aws-cli/2.33.13 Python/3.13.11 Darwin/25.2.0 exe/arm64`
running `aws sts get-caller-identity --output json --profile <name>` against an isolated
`AWS_CONFIG_FILE` + `HOME` (no real `~/.aws` was read or mutated).

Capture method: `AWS_CONFIG_FILE=<tmp> HOME=<tmp> aws sts get-caller-identity ... 2>&1`

Each file is one scenario. The filename describes the scenario.
Exit code for all: **255** from the real `aws` binary.
After fix, `parseAwsError(content, 255)` maps all to **AUTH_EXPIRED** (exit 253 from aws-axi).

## Config used

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
