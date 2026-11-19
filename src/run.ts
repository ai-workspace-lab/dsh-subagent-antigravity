/**
 * One-shot Google Antigravity CLI (`agy`) lifecycle: spawn headless `agy` under
 * the shared subprocess owner, parse NDJSON `stream-json` events, map strict
 * `SUCCESS` results to completion, and dispose to whole-range quiescence.
 *
 * @module @ai-workspace-lab/dsh-subagent-antigravity/run
 */

import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  antigravitySpawnSpec,
  type AntigravityPermissionMode,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

type AntigravityFailureStage =
  | 'query-start'
  | 'query-run'
  | 'process'
  | 'teardown'

type AntigravityFailureCategory =
  | 'limit'
  | 'product-error'
  | 'invalid-result'
  | 'process'
  | 'unknown'

export interface AntigravityFailureFacts {
  readonly stage: AntigravityFailureStage
  readonly category: AntigravityFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: AntigravityFailureFacts): string {
  const fields = [
    'product: Antigravity',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  const exitCode = facts.outcome?.exitCode
  if (exitCode !== null && exitCode !== undefined) {
    fields.push(`exit code: ${exitCode}`)
  }
  const signal = facts.outcome?.signal
  if (signal !== null && signal !== undefined) {
    fields.push(`signal: ${signal}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

export class AntigravityFailure extends Error {
  constructor(
    readonly facts: AntigravityFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-antigravity: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'AntigravityFailure'
  }
}

/**
 * Hide an unpublished product startup failure behind fixed safe facts.
 */
export function antigravityStartupFailure(cause: unknown): Error {
  return new AntigravityFailure({
    stage: 'query-start',
    category: 'unknown',
  }, cause)
}

/** Fully resolved inputs for one headless Antigravity CLI run. */
export interface AntigravityRunSpec {
  /** CLI executable name or path (default `agy`). */
  readonly command: string
  /** Selected child working directory supplied to the CLI. */
  readonly cwd: string
  /** Profile-selected native model slug; omitted to inherit `agy` settings. */
  readonly model?: string
  /** Profile-selected non-interactive permission/execution mode. */
  readonly permissionMode: AntigravityPermissionMode
  /** Whether to pass `--sandbox` to `agy`. */
  readonly sandbox: boolean
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Optional extra CLI flags appended after standard arguments. */
  readonly extraArgs?: readonly string[]
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Host diagnostic sink for a product failure kept outside model-visible text. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** Parsed terminal `result` event from `agy --output-format stream-json` or `json`. */
export interface AntigravityResultEvent {
  readonly event?: string
  readonly type?: string
  readonly status?: string
  readonly response?: string
  readonly result?: string
  readonly error?: string | { readonly message?: string }
  readonly message?: string
  readonly duration_seconds?: number
  readonly num_turns?: number
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Validate and preserve the one-shot task before crossing the CLI boundary.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-antigravity: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-antigravity: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-antigravity: the one-shot task must not be empty')
  }
  return texts.join('')
}

function extractErrorMessage(event: AntigravityResultEvent): string | undefined {
  if (typeof event.error === 'string' && event.error.trim().length > 0) {
    return event.error
  }
  if (
    typeof event.error === 'object'
    && event.error !== null
    && typeof event.error.message === 'string'
    && event.error.message.trim().length > 0
  ) {
    return event.error.message
  }
  if (typeof event.message === 'string' && event.message.trim().length > 0) {
    return event.message
  }
  return undefined
}

function classifyStatusFailure(status: string): AntigravityFailureCategory {
  const upper = status.toUpperCase()
  if (
    upper.includes('LIMIT')
    || upper.includes('MAX_TURNS')
    || upper.includes('QUOTA')
    || upper.includes('BUDGET')
  ) {
    return 'limit'
  }
  if (upper.includes('ERROR') || upper.includes('FAIL')) {
    return 'product-error'
  }
  return 'unknown'
}

/**
 * Strictly derive the only CLI result that can complete a shared run.
 */
export function successfulResult(event: AntigravityResultEvent): string {
  const status = (event.status ?? '').toUpperCase()
  if (status !== 'SUCCESS' && status !== 'OK' && status !== 'COMPLETED') {
    const category = status.length > 0
      ? classifyStatusFailure(status)
      : 'invalid-result'
    const detail = extractErrorMessage(event)
    throw new AntigravityFailure(
      { stage: 'query-run', category },
      detail === undefined ? undefined : new Error(detail),
    )
  }
  const text = typeof event.response === 'string'
    ? event.response
    : typeof event.result === 'string'
      ? event.result
      : undefined
  if (text === undefined || text.trim().length === 0) {
    throw new AntigravityFailure({
      stage: 'query-run',
      category: 'invalid-result',
    })
  }
  return text
}

/**
 * Parse a single NDJSON line from `agy --output-format stream-json`.
 */
export function parseAntigravityEventLine(
  line: string,
): AntigravityResultEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0 || !trimmed.startsWith('{')) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as AntigravityResultEvent
  } catch {
    return undefined
  }
}

function isResultEvent(event: AntigravityResultEvent): boolean {
  if (event.event === 'result' || event.type === 'result') {
    return true
  }
  // Support single-object `--output-format json` fallback envelopes.
  return (
    event.event === undefined
    && event.type === undefined
    && typeof event.status === 'string'
  )
}

function isErrorEvent(event: AntigravityResultEvent): boolean {
  return event.event === 'error' || event.type === 'error'
}

/**
 * Consume the complete `agy` stdout NDJSON stream and require one strict
 * success result plus normal stream completion.
 */
export async function consumeAntigravityStream(
  stdout: NodeJS.ReadableStream,
  onResult?: () => void,
): Promise<SubagentResult> {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let answer: string | undefined
  let lastErrorEvent: AntigravityResultEvent | undefined

  const handleLine = (line: string): void => {
    const parsed = parseAntigravityEventLine(line)
    if (parsed === undefined) return
    if (isResultEvent(parsed)) {
      onResult?.()
      answer = successfulResult(parsed)
      return
    }
    if (isErrorEvent(parsed)) {
      lastErrorEvent = parsed
    }
  }

  for await (const chunk of stdout) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer)
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      handleLine(line)
      newlineIndex = buffer.indexOf('\n')
    }
  }

  buffer += decoder.end()
  if (buffer.trim().length > 0) {
    handleLine(buffer)
  }

  if (answer === undefined) {
    if (lastErrorEvent !== undefined) {
      const detail = extractErrorMessage(lastErrorEvent)
      throw new AntigravityFailure(
        { stage: 'query-run', category: 'product-error' },
        detail === undefined ? undefined : new Error(detail),
      )
    }
    throw new AntigravityFailure({
      stage: 'query-run',
      category: 'invalid-result',
    })
  }

  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Terminate the managed Antigravity child process and wait for quiescence.
 */
export async function disposeAntigravityChild(
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )

  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (firstFailure !== undefined) {
    throw new AntigravityFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, firstFailure)
  }
  await child.done.catch(() => {})
}

/**
 * Start one headless Antigravity CLI run and publish its one-shot handle.
 */
export async function startAntigravityRun(
  request: SubagentStartRequest,
  spec: AntigravityRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (isAborted(request.signal)) {
    throw new Error('subagent-antigravity: request was aborted before CLI startup')
  }

  let child: SubprocessHandle | undefined
  let processOutcome: SubprocessOutcome | undefined
  let childFailure: Error | undefined

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-antigravity: run cancelled locally'))
    }
    child?.terminate()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const reportFailure = (error: Error): void => {
    try {
      spec.onError?.(error, 'error')
    } catch {
      // Host diagnostic logging cannot replace the product failure.
    }
  }

  try {
    const spawnSpec = antigravitySpawnSpec(
      {
        command: spec.command,
        prompt,
        cwd: spec.cwd,
        ...spec.model === undefined ? {} : { model: spec.model },
        permissionMode: spec.permissionMode,
        sandbox: spec.sandbox,
        env: spec.env,
        signal: controller.signal,
        ...spec.extraArgs === undefined ? {} : { extraArgs: spec.extraArgs },
      },
      spec.disposeGraceMs,
    )
    child = spec.spawn(spawnSpec)
    if (child.stdout === null || child.stdout === undefined) {
      throw new Error('subagent-antigravity: subprocess did not expose stdout pipe')
    }
    if (isAborted(controller.signal)) {
      throw new Error('subagent-antigravity: request was aborted before CLI startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeAntigravityChild(child)
      } catch (disposeError: unknown) {
        const failure = antigravityStartupFailure(error)
        const cleanupFailure = thrown(disposeError)
        const aggregate = new AggregateError(
          [failure, cleanupFailure],
          `${failure.message}; ${cleanupFailure.message}`,
        )
        reportFailure(aggregate)
        throw aggregate
      }
    }
    if (cancelledBeforeCleanup || isAborted(request.signal)) {
      throw new Error('subagent-antigravity: request was aborted before CLI startup')
    }
    const failure = antigravityStartupFailure(error)
    reportFailure(failure)
    throw failure
  }

  const publishedChild = child
  const publishedStdout = child.stdout as NodeJS.ReadableStream
  const childProcessFailure = publishedChild.done.then(
    (outcome) => {
      processOutcome = outcome
      return new Promise<never>(() => {})
    },
    (error: unknown) => {
      childFailure = thrown(error)
      throw childFailure
    },
  )
  void childProcessFailure.catch(() => {})

  let diagnostic: string | undefined
  let receivedResult = false

  const result = settleRunResult({
    attempt: async () => {
      try {
        const streamResult = await Promise.race([
          consumeAntigravityStream(publishedStdout, () => {
            receivedResult = true
          }),
          childProcessFailure,
        ])
        // Ensure process exit is observed if it already settled.
        await Promise.resolve()
        if (
          processOutcome !== undefined
          && processOutcome.exitCode !== 0
          && processOutcome.exitCode !== null
        ) {
          throw new AntigravityFailure({
            stage: 'process',
            category: 'process',
            outcome: processOutcome,
          })
        }
        return streamResult
      } catch (error: unknown) {
        await Promise.resolve()
        let facts: AntigravityFailureFacts
        if (error instanceof AntigravityFailure) {
          facts = { ...error.facts, outcome: error.facts.outcome ?? processOutcome }
        } else if (processOutcome !== undefined && !receivedResult) {
          facts = {
            stage: 'process',
            category: 'process',
            outcome: processOutcome,
          }
        } else {
          facts = {
            stage: 'query-run',
            category: 'unknown',
            outcome: processOutcome,
          }
        }
        diagnostic = failureDiagnostic(facts)
        throw error instanceof AntigravityFailure
          ? error
          : new AntigravityFailure(facts, thrown(error))
      }
    },
    collectOutput: () => [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel: () => {
      requestCancel()
      publishedChild.terminate()
    },
    teardown: async () => {
      try {
        await disposeAntigravityChild(publishedChild)
      } catch (error: unknown) {
        const failure = thrown(error)
        reportFailure(failure)
        throw failure
      }
    },
  })
}
