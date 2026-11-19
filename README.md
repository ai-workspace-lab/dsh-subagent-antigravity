# @ai-workspace-lab/dsh-subagent-antigravity

English | [中文](README.zh.md)

One-shot Google Antigravity subagent provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), modeled after `@deepseek-ai/dsh-subagent-claude-code`.

## Summary

Enable this Profile Bundle when a delegated task should run as a fresh, unattended Google Antigravity CLI (`agy`) session in the parent workspace. Each run accepts one self-contained text task, invokes `agy -p <prompt> --output-format stream-json` under DSH's shared `subprocess` owner, and returns the final answer or a safe failure diagnostic.

## Installation

```sh
dsh plugin add @ai-workspace-lab/dsh-subagent-antigravity
# or from GitHub
dsh plugin add github:ai-workspace-lab/dsh-subagent-antigravity
```

Prerequisite: install and authenticate the Google Antigravity CLI (`agy`) on the host, or configure `command` / `env` (e.g. `GEMINI_API_KEY`) in the plugin config.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `antigravity` | Registry name on `ctx.subagents` |
| `command` | `agy` | Antigravity CLI executable name or absolute path |
| `model` | native `agy` settings | Optional model slug passed via `--model` |
| `env` | `{}` | Explicit environment variables layered over the credential-scrubbed parent environment |
| `permissionMode` | `auto` | One of `auto`, `accept-edits`, `plan`, or `bypassPermissions` (`--dangerously-skip-permissions`) |
| `sandbox` | `false` | Pass `--sandbox` for OS-level terminal sandboxing |
| `extraArgs` | `[]` | Additional CLI flags appended after standard arguments |
| `disposeGraceMs` | `3000` | Grace in milliseconds between managed subprocess termination tiers |

## Cordis Patch (`cordis.patch.yml`)

```yaml
- insert:
    - id: subagent-antigravity
      name: '@ai-workspace-lab/dsh-subagent-antigravity'
    - id: tool-subagent-antigravity
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: antigravity
        toolName: subagent_antigravity
        maxDepth: provider-managed
```

## Development

```sh
npm install
npm run check
```
