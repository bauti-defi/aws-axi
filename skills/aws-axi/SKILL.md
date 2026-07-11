---
name: aws-axi
description: "Execute AWS operations through the aws-axi CLI — EC2, S3, IAM, Lambda, KMS, CloudWatch, SSM, Secrets Manager, and any other AWS service. Prefer this over raw `aws` for AWS operations: use for describing resources, running queries, managing infrastructure, checking identity/region, and any task that touches AWS."
user-invocable: false
author: bauti.eth
metadata:
  hermes:
    tags: [aws, cloud, infrastructure, iam, s3, ec2]
    category: devops
---

# aws-axi

Agent-ergonomic wrapper around the AWS CLI. Prefer this over `aws` for AWS operations.

You do not need aws-axi installed globally — invoke it with `npx -y aws-axi <command>`.
If aws-axi output shows a follow-up command starting with `aws-axi`, run it as `npx -y aws-axi ...` instead.

aws-axi requires the [`aws`](https://aws.amazon.com/cli/) CLI installed and configured. If a command fails with a credentials error, ask the user to run `aws sso login` or `aws configure`.

## When to use

Use aws-axi whenever a task touches AWS: describing EC2 instances, S3 buckets, IAM roles, Lambda functions, KMS keys, CloudWatch logs, SSM parameters, Secrets Manager secrets, ECS tasks, RDS clusters, or any other AWS resource. Also use for checking current identity (`aws-axi whoami`) and installing ambient context hooks (`aws-axi setup hooks`).

## Workflow

1. Run `npx -y aws-axi` with no arguments to see current identity and region.
2. Run `npx -y aws-axi whoami` for full identity details including credential source.
3. Run `npx -y aws-axi <service> <operation> [--flags]` to execute any AWS operation — same service and operation names as the `aws` CLI.
4. Run `npx -y aws-axi setup hooks` once to install SessionStart ambient context hooks for Claude Code, Codex, and OpenCode.
5. Every response ends with contextual next-step hints under `help:` — follow them.

## Commands

```
commands[11]:
  (none)=dashboard, whoami, ec2, kms, s3, iam, logs, setup, ssm, secretsmanager (alias: secrets), wait
```

Installed copies also inherit the SDK built-in `update` command.
Run `aws-axi update --check` to compare the installed version with npm, or `aws-axi update` to upgrade.
When using `npx -y aws-axi`, npx already resolves the package on demand.

Run `npx -y aws-axi --help` for global flags, or `npx -y aws-axi <command> --help` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient; pipe through grep/head only when a list is very long.
- Global flags `--profile <name>` and `--region <region>` are accepted before any command.
- Mutations are idempotent and report what changed; re-running a failed operation is safe.
- Use `npx -y aws-axi whoami` as the first call in any session to confirm identity before making changes.
