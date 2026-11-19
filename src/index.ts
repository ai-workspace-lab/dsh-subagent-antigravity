/**
 * Profile-named Google Antigravity one-shot subagent provider. Every accepted run
 * invokes `agy -p ... --output-format stream-json` in the delegating Session's
 * workspace under the shared subprocess owner.
 *
 * @module @ai-workspace-lab/dsh-subagent-antigravity
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  assertUsableCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  ANTIGRAVITY_PERMISSION_MODES,
  DEFAULT_ANTIGRAVITY_COMMAND,
  DEFAULT_ANTIGRAVITY_PERMISSION_MODE,
  type AntigravityPermissionMode,
} from './process.ts'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  antigravityStartupFailure,
  startAntigravityRun,
  type AntigravityRunSpec,
} from './run.ts'

export const name = 'subagent-antigravity'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'antigravity'

/** Deployment-owned CLI, model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `antigravity`). */
  providerName?: string
  /** Antigravity CLI executable name or absolute path (default `agy`). */
  command?: string
  /** Native Antigravity model slug fixed for this instance; omitted to inherit `agy` settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `auto`; `accept-edits` accepts edits, `plan` runs in planning mode, and
   * `bypassPermissions` passes `--dangerously-skip-permissions`.
   */
  permissionMode?: AntigravityPermissionMode
  /** Enable OS-level terminal sandbox (`--sandbox`) when supported by `agy`. */
  sandbox?: boolean
  /** Optional extra CLI flags appended after standard arguments. */
  extraArgs?: string[]
  /** Grace in milliseconds between Antigravity managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  command: z.string().min(1).default(DEFAULT_ANTIGRAVITY_COMMAND),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...ANTIGRAVITY_PERMISSION_MODES])
    .default(DEFAULT_ANTIGRAVITY_PERMISSION_MODE),
  sandbox: z.boolean().default(false),
  extraArgs: z.array(z.string()).default([]),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'model'> & Pick<Config, 'model'>

class AntigravityProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-antigravity', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-antigravity: request was aborted before CLI startup',
        )
      }
      const failure = antigravityStartupFailure(error)
      this.ctx.logger.warn(
        `subagent-antigravity "${this.name}": child start failed: %o`,
        failure,
      )
      throw failure
    }
    const spec: AntigravityRunSpec = {
      command: this.config.command,
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      sandbox: this.config.sandbox,
      env: this.config.env,
      ...this.config.extraArgs.length === 0 ? {} : { extraArgs: this.config.extraArgs },
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-antigravity "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startAntigravityRun(request, spec)
  }
}

/**
 * Register one Profile-named Antigravity provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, CLI command, optional model, permission mode, sandbox, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    command: config.command ?? DEFAULT_ANTIGRAVITY_COMMAND,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env ?? {},
    permissionMode: config.permissionMode ?? DEFAULT_ANTIGRAVITY_PERMISSION_MODE,
    sandbox: config.sandbox ?? false,
    extraArgs: config.extraArgs ?? [],
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  assertPositiveFinite(
    'subagent-antigravity',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-antigravity: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new AntigravityProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}

export * from './process.ts'
export * from './run.ts'
