import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as plugin from '../src/index.ts'
import {
  antigravityEnvironmentOverlay,
  antigravitySpawnArgs,
  antigravitySpawnSpec,
} from '../src/process.ts'
import {
  AntigravityFailure,
  consumeAntigravityStream,
  parseAntigravityEventLine,
  startAntigravityRun,
  successfulResult,
  textTask,
  type AntigravityRunSpec,
} from '../src/run.ts'

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly stdout: PassThrough
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly terminateCalls: () => number
}

function createFakeChild(options: { exitOnTerminate?: boolean } = {}): FakeChild {
  const stdout = new PassThrough()
  let exited = false
  let terminateCount = 0
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  void done.catch(() => {})

  const settle = (outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void => {
    if (exited) return
    exited = true
    stdout.end()
    resolveDone(outcome)
  }

  const fail = (error: Error): void => {
    if (exited) return
    exited = true
    stdout.end()
    rejectDone(error)
  }

  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout,
    stderr: undefined,
    control: undefined,
    collected: {},
    done,
    terminate: () => {
      terminateCount += 1
      if (options.exitOnTerminate !== false) {
        settle({ exitCode: 0, signal: 'SIGTERM' })
      }
    },
    waitForExit: async () => {
      await done.catch(() => {})
      return true
    },
  }

  return {
    handle,
    stdout,
    settle,
    fail,
    terminateCalls: () => terminateCount,
  }
}

function baseSpec(
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  overrides: Partial<AntigravityRunSpec> = {},
): AntigravityRunSpec {
  return {
    command: 'agy',
    cwd: process.cwd(),
    permissionMode: 'auto',
    sandbox: false,
    env: {},
    disposeGraceMs: 3_000,
    spawn,
    ...overrides,
  }
}

describe('textTask', () => {
  it('joins multiple text blocks verbatim', () => {
    assert.equal(
      textTask([
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ]),
      'hello world',
    )
  })

  it('rejects empty, whitespace-only, or non-text prompts', () => {
    assert.throws(() => textTask([]), /only text blocks/)
    assert.throws(() => textTask([{ type: 'text', text: '   \n\t  ' }]), /must not be empty/)
    assert.throws(
      () => textTask([{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: '' } } as never]),
      /only text blocks/,
    )
  })
})

describe('antigravitySpawnSpec', () => {
  it('builds headless stream-json CLI arguments with mode, model, sandbox, and extraArgs', () => {
    const args = antigravitySpawnArgs({
      prompt: 'summarize repo',
      model: 'gemini-3-flash',
      permissionMode: 'plan',
      sandbox: true,
      extraArgs: ['--verbose'],
    })
    assert.deepEqual(args, [
      '-p',
      'summarize repo',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3-flash',
      '--mode',
      'plan',
      '--sandbox',
      '--verbose',
    ])
  })

  it('uses --dangerously-skip-permissions for bypassPermissions mode', () => {
    const args = antigravitySpawnArgs({
      prompt: 'fix bug',
      permissionMode: 'bypassPermissions',
      sandbox: false,
    })
    assert.deepEqual(args, [
      '-p',
      'fix bug',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
    ])
  })

  it('scrubs ambient credentials while preserving explicit env overrides', () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'secret-ambient-key'
    try {
      const overlay = antigravityEnvironmentOverlay({ GEMINI_API_KEY: 'explicit-key' })
      assert.equal(overlay.OPENAI_API_KEY, undefined)
      assert.equal(overlay.GEMINI_API_KEY, 'explicit-key')
    } finally {
      if (prev === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = prev
      }
    }
  })

  it('rejects empty cwd or empty command', () => {
    const signal = new AbortController().signal
    assert.throws(
      () => antigravitySpawnSpec({
        command: 'agy',
        prompt: 'hi',
        cwd: '',
        permissionMode: 'auto',
        sandbox: false,
        env: {},
        signal,
      }, 3000),
      /omitted its workspace/,
    )
    assert.throws(
      () => antigravitySpawnSpec({
        command: '   ',
        prompt: 'hi',
        cwd: process.cwd(),
        permissionMode: 'auto',
        sandbox: false,
        env: {},
        signal,
      }, 3000),
      /command must not be empty/,
    )
  })
})

describe('stream-json parsing & result validation', () => {
  it('parses NDJSON lines and ignores non-JSON lines', () => {
    assert.equal(parseAntigravityEventLine(''), undefined)
    assert.equal(parseAntigravityEventLine('not json'), undefined)
    assert.equal(parseAntigravityEventLine('[1,2,3]'), undefined)
    assert.deepEqual(
      parseAntigravityEventLine('{"event":"result","status":"SUCCESS","response":"done"}'),
      { event: 'result', status: 'SUCCESS', response: 'done' },
    )
  })

  it('validates successfulResult and classifies error/limit statuses', () => {
    assert.equal(
      successfulResult({ event: 'result', status: 'SUCCESS', response: 'ok' }),
      'ok',
    )
    assert.throws(
      () => successfulResult({ event: 'result', status: 'SUCCESS', response: '   ' }),
      (err: unknown) => err instanceof AntigravityFailure && err.facts.category === 'invalid-result',
    )
    assert.throws(
      () => successfulResult({ event: 'result', status: 'LIMIT_EXCEEDED', error: 'max turns' }),
      (err: unknown) => err instanceof AntigravityFailure && err.facts.category === 'limit',
    )
    assert.throws(
      () => successfulResult({ event: 'result', status: 'ERROR', error: 'auth failed' }),
      (err: unknown) => err instanceof AntigravityFailure && err.facts.category === 'product-error',
    )
  })

  it('consumes chunked NDJSON streams with trailing line', async () => {
    const stream = new PassThrough()
    const promise = consumeAntigravityStream(stream)
    stream.write('{"event":"init"}\n{"event":"step_update","step":1}\n')
    stream.write('{"event":"result","status":"SUCCESS","response":"final answer"}')
    stream.end()
    const result = await promise
    assert.deepEqual(result, {
      output: [{ type: 'text', text: 'final answer' }],
      stopReason: 'completed',
    })
  })
})

describe('startAntigravityRun', () => {
  it('completes a one-shot run and returns the final answer', async () => {
    const child = createFakeChild()
    let capturedSpec: SubprocessSpawnSpec | undefined
    const run = await startAntigravityRun(
      {
        prompt: [{ type: 'text', text: 'explain this' }],
        parent: { id: 'parent' } as never,
        signal: new AbortController().signal,
      },
      baseSpec((spec) => {
        capturedSpec = spec
        return child.handle
      }),
    )

    assert.equal(capturedSpec?.argv[0], 'agy')
    child.stdout.write('{"event":"result","status":"SUCCESS","response":"explained"}\n')
    child.settle({ exitCode: 0, signal: null })

    const result = await run.result
    assert.equal(result.stopReason, 'completed')
    assert.deepEqual(result.output, [{ type: 'text', text: 'explained' }])
  })

  it('aborts an in-flight run when parent signal aborts', async () => {
    const child = createFakeChild()
    const ac = new AbortController()
    const run = await startAntigravityRun(
      {
        prompt: [{ type: 'text', text: 'long task' }],
        parent: { id: 'parent' } as never,
        signal: ac.signal,
      },
      baseSpec(() => child.handle),
    )

    ac.abort()
    const result = await run.result
    assert.equal(result.stopReason, 'aborted')
    assert.ok(child.terminateCalls() >= 1)
  })

  it('fails with process diagnostic on non-zero exit without result', async () => {
    const child = createFakeChild()
    const run = await startAntigravityRun(
      {
        prompt: [{ type: 'text', text: 'fail task' }],
        parent: { id: 'parent' } as never,
        signal: new AbortController().signal,
      },
      baseSpec(() => child.handle),
    )

    child.settle({ exitCode: 1, signal: null })
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic ?? '', /product: Antigravity/)
    assert.match(result.diagnostic ?? '', /exit code: 1/)
  })
})

describe('Cordis plugin registration', () => {
  it('registers provider on ctx.subagents with NO_START_CAPABILITIES', () => {
    const registered: Array<{ name: string; capabilities: unknown; inheritsParentContext: boolean }> = []
    const ctx = {
      subagents: {
        registerProvider(provider: { name: string; capabilities: unknown; inheritsParentContext: boolean }) {
          registered.push(provider)
        },
      },
      subprocess: { spawn: () => { throw new Error('unused') } },
      logger: { warn: () => {} },
    } as unknown as Context

    plugin.apply(ctx, {})
    assert.equal(registered.length, 1)
    assert.equal(registered[0]?.name, 'antigravity')
    assert.deepEqual(registered[0]?.capabilities, NO_START_CAPABILITIES)
    assert.equal(registered[0]?.inheritsParentContext, false)
  })

  it('rejects out-of-range disposeGraceMs', () => {
    const ctx = {
      subagents: { registerProvider() {} },
      subprocess: {},
      logger: { warn: () => {} },
    } as unknown as Context

    assert.throws(() => plugin.apply(ctx, { disposeGraceMs: 0 }), /disposeGraceMs/)
    assert.throws(
      () => plugin.apply(ctx, { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }),
      /disposeGraceMs/,
    )
  })
})
