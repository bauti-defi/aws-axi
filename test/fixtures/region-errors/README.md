# Region error fixtures

Byte-exact captures of the real `aws` CLI stderr when no region is configured.

## Capture methodology

All files were captured by running the real `aws` CLI inside official
`amazon/aws-cli` Docker containers with a completely isolated environment:
empty `AWS_CONFIG_FILE`, clean isolated `HOME`, and no `AWS_DEFAULT_REGION` /
`AWS_REGION` env vars present (unset, not set to empty — an empty-string value
yields a different error: `Invalid endpoint: https://lambda..amazonaws.com`).
Stderr was redirected with `2>` straight to a file; no shell processing touched
the bytes. All three ≥2.34 captures were `cmp`-verified byte-identical to each
other before committing a single representative file.

```sh
# Canonical capture recipe:
docker run --rm --entrypoint /bin/sh amazon/aws-cli:<version> -c '
  mkdir -p /tmp/isolated-home && touch /tmp/isolated-home/config
  AWS_CONFIG_FILE=/tmp/isolated-home/config \
  AWS_SHARED_CREDENTIALS_FILE=/nonexistent \
  HOME=/tmp/isolated-home \
  aws lambda invoke --function-name f /dev/null 2>/tmp/out/stderr.bin
'
```

`no-region.txt` was also independently captured on macOS (aws-cli/2.33.13,
`env -i` isolation) and is `cmp`-identical to the Docker 2.33.13 capture.

## Files

| File | Version(s) captured | Byte count | Verified |
|---|---|---|---|
| `no-region.txt` | aws-cli/2.33.13 (macOS + Docker) | 91 | `cmp`-identical |
| `no-region-prefixed-2.34.txt` | aws-cli/2.34.0, 2.36.2, 2.36.7 — **byte-identical** | 135 | `cmp`-identical across all three |

## Byte layout

**`no-region.txt` (91 bytes, aws-cli 2.33.x)**

No dedicated handler in this version — plain text, no prefix, no wrapper:
```
0x0a  "You must specify a region. You can also configure your region by running \"aws configure\".\n"
```

**`no-region-prefixed-2.34.txt` (135 bytes, aws-cli ≥ 2.34.0)**

`NoRegionErrorHandler` wraps the message in the enhanced error format (default
since 2.34.0, shipped together with the `aws: [ERROR]:` prefix in that release):
```
0x0a  "aws: [ERROR]: An error occurred (NoRegion): You must specify a region. You can also configure your region by running \"aws configure\".\n"
```

## Why the SSO prefix transform does NOT apply here

The SSO error fixtures in `../sso-errors/` are derived by inserting
`aws: [ERROR]: ` after the leading `\n` because SSO errors have no dedicated
handler and fall to `GeneralExceptionHandler` → `write_error(stderr, str(exception))`
— plain text, no wrapper.

`NoRegionError` has a dedicated `NoRegionErrorHandler` that formats the message
as `An error occurred (NoRegion): <text>` before the prefix is added. Applying
only the SSO prefix transform to the 2.33.x capture produces an invented string
that aws-cli has never emitted. This was the root cause of the originally-fabricated
fixture — and is why this file now holds a real Docker capture instead.

**Do NOT `.trim()` these files.** Every file starts with `0x0a` (the blank line
the aws binary writes before every error message). Tests must feed `parseAwsError`
the same bytes production (`src/aws.ts`) does — without trimming.
