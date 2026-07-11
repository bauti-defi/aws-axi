# aws-axi

**An agent-ergonomic wrapper over the `aws` CLI.** `aws-axi` mirrors the AWS CLI 1:1 and
re-presents it for autonomous agents — token-efficient [TOON](https://toonformat.dev/)
output, capped pagination with honest totals, model-derived signatures instead of
thousand-line help pages, structured errors, and next-step suggestions.

It is the AWS analogue of [`gh-axi`](https://github.com/kunchenguid/gh-axi), built on
[`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) and the
[AXI standard](https://github.com/kunchenguid/axi).

```
aws-axi <service> <operation> [--flags]   # mirrors: aws <service> <operation> [--flags]
```

## Why

The `aws` CLI is built for humans at a terminal. For an LLM deciding the next command it is
hostile: verbose JSON, **auto-pagination that dumps multi-MB blobs in one call**, help pages
thousands of lines long, and errors buried in stderr. `aws-axi` keeps AWS's exact interface
but changes the *output* and *ergonomics* so an agent can act in one turn.

## How

Two layers over the real `aws` binary (we shell out to it — never reimplement AWS APIs):

- **A model-driven generic engine.** `aws-axi` reads the same [botocore](https://github.com/boto/botocore)
  service models the AWS CLI is generated from, so **all ~18,000 operations work on day one**
  — with distilled signatures, required-param detection, honest pagination, and structured
  errors, auto-tracking every `aws` release.
- **Hand-polished overlays** for the highest-value, most foundational services (identity,
  IAM, EC2, CloudWatch Logs, S3, KMS, …) — curated schemas, idempotent mutations, secret
  redaction, and reference-resolution (show a security group's *name*, not `sg-…`).

## Status

🚧 **Early design / pre-implementation.** The design is in
[`docs/specs/2026-07-11-aws-axi-design.md`](docs/specs/2026-07-11-aws-axi-design.md).
Implementation is tracked in the issues.

## License

[MIT](LICENSE)
