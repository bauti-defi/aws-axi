# Region error fixtures

Byte-exact captures of the real `aws` CLI stderr when no region is configured.

## Capture methodology

All files were captured by running the real `aws` CLI with an isolated, empty
`AWS_CONFIG_FILE` and a clean `HOME` (no env region vars) so the binary cannot
resolve a region from any source:

```sh
ISOLATED=$(mktemp -d)
cat > "$ISOLATED/config" <<'EOF'
EOF
env -i PATH="$PATH" HOME="$ISOLATED" AWS_CONFIG_FILE="$ISOLATED/config" \
  aws lambda invoke --function-name f /tmp/out.json \
  2>test/fixtures/region-errors/no-region.txt
```

aws-cli version during capture: `aws-cli/2.33.13 Python/3.13.11 Darwin/25.2.0`

## Files

| File | Scenario |
|---|---|
| `no-region.txt` | Plain stderr from aws-cli 2.33.x (starts with `\n`) |
| `no-region-prefixed-2.34.txt` | Simulated aws-cli ≥ 2.34.0 format: `\naws: [ERROR]: <message>\n` |

## Byte layout

Every captured file starts with `0x0a` (the blank line the aws binary writes
before every error message) followed by the error text and a trailing newline.
The `no-region-prefixed-2.34.txt` file is derived by inserting the
`aws: [ERROR]: ` prefix after the leading newline — the same transformation
used for SSO error fixtures in `test/fixtures/sso-errors/`.

**Do NOT `.trim()` these files.** Tests must feed `parseAwsError` the same
bytes production (`src/aws.ts`) does — without trimming.
