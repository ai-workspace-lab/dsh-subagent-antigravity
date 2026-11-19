# @ai-workspace-lab/dsh-subagent-antigravity

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) 的一次性 Google Antigravity 子智能体提供者插件，参考 `@deepseek-ai/dsh-subagent-claude-code` 实现。

## 简介

当需要把子任务委派给独立、无交互的 Google Antigravity CLI (`agy`) 在父会话工作区中执行时，启用本插件包。每次运行接收一个自包含的文本任务，通过 DSH 共享的 `subprocess` 服务启动 `agy -p <prompt> --output-format stream-json`，并将最终回答或安全诊断信息返回给父会话。

## 安装

```sh
dsh plugin add @ai-workspace-lab/dsh-subagent-antigravity
# 或从 GitHub 安装
dsh plugin add github:ai-workspace-lab/dsh-subagent-antigravity
```

前置要求：宿主机需已安装并完成 `agy` 登录认证，或在插件配置中通过 `command` / `env`（如 `GEMINI_API_KEY`）指定。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `providerName` | `antigravity` | 注册到 `ctx.subagents` 的提供者名称 |
| `command` | `agy` | Antigravity CLI 可执行文件名或绝对路径 |
| `model` | 沿用 `agy` 原生配置 | 可选模型标识，通过 `--model` 传入 |
| `env` | `{}` | 叠加在脱敏父环境变量之上的显式环境变量 |
| `permissionMode` | `auto` | 可选 `auto`、`accept-edits`、`plan`、`bypassPermissions`（对应 `--dangerously-skip-permissions`） |
| `sandbox` | `false` | 是否传入 `--sandbox` 启用系统级终端沙箱 |
| `extraArgs` | `[]` | 追加在标准参数后的额外 CLI 参数 |
| `disposeGraceMs` | `3000` | 子进程终止分级的宽限时间（毫秒） |

## 开发与校验

```sh
npm install
npm run check
```
