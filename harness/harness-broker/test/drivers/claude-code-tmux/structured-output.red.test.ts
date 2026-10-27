import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import {
  type HookEnvelopeHandler,
  createClaudeCodeTmuxDriver,
} from '../../../src/drivers/claude-code-tmux/driver'
import type { DriverContext } from '../../../src/drivers/driver'
import { inputIdFrom, invocationIdFrom } from '../../ids'
import { removeTempHookDirs, tempHookSocketPath } from './driver-red.helpers'

type TmuxExecCall = {
  argv: string[]
  env?: Record<string, string | undefined> | undefined
  loadedText?: string | undefined
}

type PaneLease = {
  kind: 'tmux-pane'
  ownership: 'hrc'
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName?: string | undefined
  allowedOps: {
    inspect: true
    sendInput: true
    sendInterrupt: true
    capture?: boolean | undefined
  }
}

type HookHandler = HookEnvelopeHandler

afterEach(removeTempHookDirs)

/** The current test's hook socket, under a per-test temp dir (see setupDriver). */
let hookSocket = ''

const now = () => new Date('2026-06-24T02:20:00.000Z')

const lease = (): PaneLease => ({
  kind: 'tmux-pane',
  ownership: 'hrc',
  socketPath: '/tmp/preallocated/structured-output.sock',
  sessionId: '$42',
  windowId: '@42',
  paneId: '%42',
  sessionName: 'structured-output',
  allowedOps: {
    inspect: true,
    sendInput: true,
    sendInterrupt: true,
    capture: true,
  },
})

const spec = (): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom('inv_claude_structured'),
  harness: {
    frontend: 'claude-code',
    provider: 'anthropic',
    driver: 'claude-code-tmux',
  },
  process: {
    command: '/opt/bin/claude',
    args: ['--model', 'sonnet'],
    cwd: process.cwd(),
    lockedEnv: { ANTHROPIC_API_KEY: 'test-key' },
    harnessTransport: { kind: 'pty' },
    limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 500 },
  },
  interaction: {
    mode: 'interactive',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'claude-code-tmux',
    terminalHost: 'tmux',
  },
  correlation: {
    hostSessionId: 'host-structured',
    runtimeId: 'runtime-structured',
  },
})

const schemaResponse = (schema: Record<string, unknown>): InvocationInput['responseFormat'] =>
  ({
    kind: 'json_schema',
    schema,
  }) as InvocationInput['responseFormat']

const statusSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { status: { type: 'string' } },
  required: ['status'],
}

const countSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { count: { type: 'number' } },
  required: ['count'],
}

function input(
  inputId: string,
  text: string,
  responseFormat?: InvocationInput['responseFormat']
): InvocationInput {
  return {
    inputId: inputIdFrom(inputId),
    kind: 'user',
    content: [{ type: 'text', text }],
    ...(responseFormat !== undefined ? { responseFormat } : {}),
  }
}

function createRecordingExec(calls: TmuxExecCall[], paneLease: PaneLease = lease()) {
  let pendingLine = ''
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    const call: TmuxExecCall = { argv, env: options?.env }
    calls.push(call)
    if (argv.includes('display-message')) {
      return {
        stdout: `${paneLease.sessionId}\t${paneLease.windowId}\t${paneLease.paneId}\n`,
        stderr: '',
      }
    }
    if (argv.includes('load-buffer')) {
      pendingLine = readFileSync(argv.at(-1) ?? '', 'utf8')
      call.loadedText = pendingLine
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('send-keys') && argv.includes('Enter')) {
      pendingLine = ''
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('capture-pane')) {
      return { stdout: pendingLine, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
}

function createCtx(events: InvocationEventEnvelope[]): DriverContext {
  return {
    invocationId: 'inv_claude_structured',
    clientCapabilities: {},
    runtime: { terminalSurface: lease() },
    emit(type, payload, extra) {
      const event = {
        invocationId: 'inv_claude_structured',
        seq: events.length + 1,
        time: now().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
  } as DriverContext
}

async function setupDriver() {
  hookSocket = tempHookSocketPath('claude-structured-output.sock')
  const tmuxCalls: TmuxExecCall[] = []
  const events: InvocationEventEnvelope[] = []
  let hookHandler: HookHandler | undefined
  const driver = createClaudeCodeTmuxDriver({
    tmux: {
      tmuxBin: '/opt/bin/tmux',
      exec: createRecordingExec(tmuxCalls),
    },
    hooks: {
      listen: async (handler) => {
        hookHandler = handler
        return { socketPath: hookSocket, close: async () => undefined }
      },
    },
    now,
  })
  await driver.start(spec(), createCtx(events))
  if (hookHandler === undefined) throw new Error('hook handler was not captured')
  return { driver, tmuxCalls, events, hookHandler }
}

function sentLiteralInputs(calls: TmuxExecCall[]): string[] {
  return calls
    .filter((call) => call.argv.includes('load-buffer'))
    .map((call) => call.loadedText ?? '')
}

function completedText(event: InvocationEventEnvelope): string {
  const content = (event.payload as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? ''
}

async function stop(
  hookHandler: HookHandler,
  turnId: string,
  lastAssistantMessage?: string | undefined,
  mailStopReason?: string | undefined
) {
  return await hookHandler({
    invocationId: 'inv_claude_structured',
    runtimeId: 'runtime-structured',
    generation: 1,
    callbackSocket: hookSocket,
    turnId,
    hookData: {
      hook_event_name: 'Stop',
      ...(lastAssistantMessage !== undefined
        ? { last_assistant_message: lastAssistantMessage }
        : {}),
    },
    ...(mailStopReason !== undefined
      ? { mailStopDecision: { decision: 'block' as const, reason: mailStopReason } }
      : {}),
  })
}

describe('claude-code-tmux JSON Schema structured-output RED contract', () => {
  test('a JSON-schema directive applies to its own turn only; the next structured or text turn carries none of it', async () => {
    const { driver, tmuxCalls } = await setupDriver()

    await driver.applyInputNow(input('input_status', 'return status', schemaResponse(statusSchema)))
    await driver.applyInputNow(input('input_count', 'return count', schemaResponse(countSchema)))
    await driver.applyInputNow(input('input_text', 'plain answer'))

    const submitted = sentLiteralInputs(tmuxCalls)
    const [statusPrompt, countPrompt, textPrompt] = submitted.slice(-3)

    // T-05145 invariant: the schema belongs to this input only. A later
    // structured turn gets its own schema, and a later text turn gets no sticky
    // schema directive from the previous structured turn.
    expect(statusPrompt).toContain('"status"')
    expect(statusPrompt).not.toContain('"count"')
    expect(countPrompt).toContain('"count"')
    expect(countPrompt).not.toContain('"status"')
    expect(textPrompt).toBe('plain answer')
  })

  test('3. schema prompting preserves the broker turn identity used by later hooks', async () => {
    const { driver, tmuxCalls, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_identity', 'return status', schemaResponse(statusSchema))
    )
    expect(applied.turnId).toBeDefined()
    const submitted = sentLiteralInputs(tmuxCalls).at(-1) ?? ''
    expect(submitted).toContain('return ONLY JSON')

    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: hookSocket,
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: submitted },
    })

    expect(events.find((event) => event.type === 'turn.started')).toMatchObject({
      turnId: applied.turnId,
      payload: { turnId: applied.turnId },
    })
  })

  test('4. composes mailbox and structured-output Stop gates without completing early', async () => {
    const { driver, events, hookHandler } = await setupDriver()
    const applied = await driver.applyInputNow(
      input('input_composed_stop', 'return status', schemaResponse(statusSchema))
    )
    const turnId = applied.turnId ?? 'missing'

    const combined = await stop(hookHandler, turnId, '{"wrong":true}', 'drain hrcmail inbox')
    const combinedReason = String(combined?.['reason'] ?? '')
    expect(combined?.['decision']).toBe('block')
    expect(combinedReason).toContain('Mailbox drain is also required')
    expect(combinedReason).toContain('drain hrcmail inbox')
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)

    const mailboxOnly = await stop(hookHandler, turnId, '{"status":"ok"}', 'drain hrcmail inbox')
    expect(mailboxOnly).toEqual({ decision: 'block', reason: 'drain hrcmail inbox' })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)

    const cleared = await stop(hookHandler, turnId, '{"status":"ok"}')
    expect(cleared).toBeUndefined()
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })

  test.each([
    { reply: 'bare JSON', schema: statusSchema, text: '{"status":"ok"}', final: '{"status":"ok"}' },
    {
      reply: 'a whole-message fenced block',
      schema: countSchema,
      text: '```json\n{"count":7}\n```',
      final: '{"count":7}',
    },
    {
      reply: 'prose-prefixed JSON',
      schema: statusSchema,
      text: 'Here is the JSON:\n{"status":"ok"}',
      final: '{"status":"ok"}',
    },
    {
      reply: 'prose-prefixed JSON with braces and brackets inside strings',
      schema: statusSchema,
      text: 'Here is the JSON:\n{"status":"ok with {braces} and [brackets]"}',
      final: '{"status":"ok with {braces} and [brackets]"}',
    },
  ])(
    'a structured turn completes once with normalized JSON when the reply is $reply',
    async ({ schema, text, final }) => {
      const { driver, events, hookHandler } = await setupDriver()

      const applied = await driver.applyInputNow(
        input('input_structured_reply', 'return structured', schemaResponse(schema))
      )
      await stop(hookHandler, applied.turnId ?? 'missing', text)

      const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
      const finals = sameTurnEvents.filter((event) => event.type === 'assistant.message.completed')
      const completions = sameTurnEvents.filter((event) => event.type === 'turn.completed')
      expect(finals).toHaveLength(1)
      expect(completions).toHaveLength(1)
      expect(finals.map(completedText)).toEqual([final])
      expect(() => JSON.parse(final)).not.toThrow()
    }
  )

  test('a structured turn is not completed when the first JSON root is invalid, absent, or followed by wrapper prose', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const schemaInvalid = await driver.applyInputNow(
      input('input_prefixed_invalid', 'return status', schemaResponse(statusSchema))
    )
    await stop(
      hookHandler,
      schemaInvalid.turnId ?? 'missing',
      'Here is the JSON:\n{"wrong":"field"}'
    )

    const noRoot = await driver.applyInputNow(
      input('input_prefixed_no_root', 'return status', schemaResponse(statusSchema))
    )
    await stop(hookHandler, noRoot.turnId ?? 'missing', 'Here is the JSON: status ok')

    const laterValid = await driver.applyInputNow(
      input('input_prefixed_later_valid', 'return status', schemaResponse(statusSchema))
    )
    await stop(
      hookHandler,
      laterValid.turnId ?? 'missing',
      'Example: {"wrong":"field"}\nActual: {"status":"ok"}'
    )

    const trailingProse = await driver.applyInputNow(
      input('input_prefixed_suffix', 'return status', schemaResponse(statusSchema))
    )
    await stop(
      hookHandler,
      trailingProse.turnId ?? 'missing',
      'Here is the JSON:\n{"status":"ok"}\nThanks'
    )

    for (const applied of [schemaInvalid, noRoot, laterValid, trailingProse]) {
      const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
      expect(sameTurnEvents.map((event) => event.type)).not.toContain('assistant.message.completed')
      expect(sameTurnEvents.map((event) => event.type)).not.toContain('turn.completed')
    }
  })

  test('10. invalid output before retry cap blocks without final/completed and keeps the same turn active', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_invalid_retry', 'return status', schemaResponse(statusSchema))
    )
    await stop(hookHandler, applied.turnId ?? 'missing', '{"wrong":"field"}')

    const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
    expect(sameTurnEvents.map((event) => event.type)).not.toContain('assistant.message.completed')
    expect(sameTurnEvents.map((event) => event.type)).not.toContain('turn.completed')
    expect(events.find((event) => event.type === 'driver.notice')).toMatchObject({
      payload: expect.objectContaining({
        message: expect.stringContaining('required'),
      }),
    })
  })

  test('11. retry cap exhaustion emits one non-retryable StructuredOutputValidationFailed turn.failed', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_retry_cap', 'return status', schemaResponse(statusSchema))
    )
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await stop(hookHandler, applied.turnId ?? 'missing', '{"wrong":"field"}')
    }

    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'turn.failed')).toMatchObject({
      turnId: applied.turnId,
      payload: {
        turnId: applied.turnId,
        code: 'StructuredOutputValidationFailed',
        retryable: false,
        data: expect.objectContaining({
          validation: expect.anything(),
        }),
      },
    })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
  })

  test('11b. same-turn API error attributes truncated structured output before generic validation', async () => {
    const { driver, events, hookHandler } = await setupDriver()
    const root = await mkdtemp(join(tmpdir(), 'claude-structured-api-error-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')

    try {
      const applied = await driver.applyInputNow(
        input('input_provider_truncated', 'return status', schemaResponse(statusSchema))
      )
      await hookHandler({
        invocationId: 'inv_claude_structured',
        runtimeId: 'runtime-structured',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: applied.turnId,
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          isApiErrorMessage: true,
          status: 503,
          requestId: 'req_truncated',
          error: 'internal_server_error',
          message: { content: [{ type: 'text', text: 'API Error: Internal server error' }] },
        })}\n`
      )

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await stop(hookHandler, applied.turnId ?? 'missing', '{"status":"trunc')
      }

      expect(events.find((event) => event.type === 'diagnostic')).toMatchObject({
        turnId: applied.turnId,
        payload: {
          level: 'error',
          data: { code: 'api_error', errorClass: 'server_error' },
        },
      })
      expect(events.find((event) => event.type === 'turn.failed')).toMatchObject({
        turnId: applied.turnId,
        payload: {
          turnId: applied.turnId,
          code: 'provider_error_truncated_output',
          retryable: false,
        },
      })
    } finally {
      await driver.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a structured turn that ends without Stop validation fails closed with a structured-output turn.failed', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_delivery_miss', 'return status', schemaResponse(statusSchema))
    )
    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: hookSocket,
      turnId: applied.turnId,
      hookData: {
        hook_event_name: 'MessageDisplay',
        message_id: 'msg_unvalidated',
        index: 0,
        final: true,
        delta: '{"wrong":"field"}',
      },
    })
    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: hookSocket,
      turnId: applied.turnId,
      hookData: { hook_event_name: 'SessionEnd', reason: 'other' },
    })

    const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
    const types = sameTurnEvents.map((event) => event.type)
    expect(types).not.toContain('assistant.message.completed')
    expect(types).not.toContain('turn.completed')
    expect(types).not.toContain('turn.interrupted')
    const failed = sameTurnEvents.filter((event) => event.type === 'turn.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.payload).toMatchObject({
      turnId: applied.turnId,
      status: 'failed',
      message: 'Structured output ended before Stop validation cleared',
      retryable: false,
    })
  })

  test('12b. SubagentStop does not fail or complete the live structured parent turn', async () => {
    const { driver, tmuxCalls, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_subagent_parent', 'return status', schemaResponse(statusSchema))
    )
    const submitted = sentLiteralInputs(tmuxCalls).at(-1) ?? ''
    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: hookSocket,
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: submitted },
    })
    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: hookSocket,
      hookData: {
        hook_event_name: 'SubagentStop',
        agent_id: 'agent-child',
        agent_type: 'Explore',
      },
    })

    const afterSubagent = events.filter((event) => event.turnId === applied.turnId)
    expect(
      afterSubagent.filter((event) => event.type === 'driver.notice').map((event) => event.payload)
    ).toContainEqual(
      expect.objectContaining({
        message: 'Subagent stop: Explore (agent-child)',
        code: 'subagent_stop',
      })
    )
    expect(afterSubagent.map((event) => event.type)).not.toContain('turn.failed')
    expect(afterSubagent.map((event) => event.type)).not.toContain('turn.completed')

    await stop(hookHandler, applied.turnId ?? 'missing', '{"status":"ok"}')

    const terminalEvents = events.filter((event) => event.turnId === applied.turnId)
    expect(terminalEvents.filter((event) => event.type === 'turn.failed')).toHaveLength(0)
    expect(terminalEvents.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(
      terminalEvents.filter((event) => event.type === 'assistant.message.completed')
    ).toHaveLength(1)
  })
})
