/**
 * Subprocess specification builder for headless Google Antigravity CLI (`agy`)
 * one-shot runs under the shared managed subprocess owner.
 *
 * @module @ai-workspace-lab/dsh-subagent-antigravity/process
 */

import {
  scrubbedParentEnv,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Default Antigravity CLI binary name resolved via PATH. */
export const DEFAULT_ANTIGRAVITY_COMMAND = 'agy'

/** Antigravity CLI permission and execution modes suitable for unattended runs. */
export const ANTIGRAVITY_PERMISSION_MODES = [
  'auto',
  'accept-edits',
  'plan',
  'bypassPermissions',
] as const

/** Profile-selectable non-interactive Antigravity permission mode. */
export type AntigravityPermissionMode = typeof ANTIGRAVITY_PERMISSION_MODES[number]

/** Safe default for unattended Antigravity CLI runs. */
export const DEFAULT_ANTIGRAVITY_PERMISSION_MODE: AntigravityPermissionMode = 'auto'

/** Inputs required to construct one Antigravity CLI subprocess spawn spec. */
export interface AntigravitySpawnOptions {
  /** CLI executable name or absolute path (default `agy`). */
  readonly command: string
  /** One-shot text prompt passed via `-p`. */
  readonly prompt: string
  /** Validated child working directory. */
  readonly cwd: string
  /** Optional model slug passed via `--model`. */
  readonly model?: string
  /** Selected non-interactive permission/execution mode. */
  readonly permissionMode: AntigravityPermissionMode
  /** Whether to pass `--sandbox` for OS-level terminal sandboxing. */
  readonly sandbox: boolean
  /** Explicit environment entries layered over the scrubbed parent env. */
  readonly env: Record<string, string>
  /** Per-run cancellation signal. */
  readonly signal: AbortSignal
  /** Optional extra CLI flags appended after standard arguments. */
  readonly extraArgs?: readonly string[]
}

/**
 * Build the explicit environment overlay for one Antigravity child process.
 * Ambient credential-shaped variables are removed by `scrubbedParentEnv()`.
 */
export function antigravityEnvironmentOverlay(
  env: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...scrubbedParentEnv(), ...env }
}

/**
 * Build CLI arguments for a headless, NDJSON-streaming `agy` invocation.
 */
export function antigravitySpawnArgs(
  options: Pick<
    AntigravitySpawnOptions,
    'prompt' | 'model' | 'permissionMode' | 'sandbox' | 'extraArgs'
  >,
): string[] {
  const args = ['-p', options.prompt, '--output-format', 'stream-json']
  if (options.model !== undefined) {
    args.push('--model', options.model)
  }
  if (options.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions')
  } else {
    args.push('--mode', options.permissionMode)
  }
  if (options.sandbox) {
    args.push('--sandbox')
  }
  if (options.extraArgs !== undefined && options.extraArgs.length > 0) {
    args.push(...options.extraArgs)
  }
  return args
}

/**
 * Translate one Antigravity headless request into a shared `SubprocessSpawnSpec`.
 */
export function antigravitySpawnSpec(
  options: AntigravitySpawnOptions,
  graceMs: number,
): SubprocessSpawnSpec {
  if (options.cwd.length === 0) {
    throw new Error('subagent-antigravity: spawn request omitted its workspace')
  }
  if (options.command.trim().length === 0) {
    throw new Error('subagent-antigravity: command must not be empty')
  }
  return {
    argv: [options.command, ...antigravitySpawnArgs(options)],
    cwd: options.cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    graceMs,
    signal: options.signal,
    env: antigravityEnvironmentOverlay(options.env),
  }
}
