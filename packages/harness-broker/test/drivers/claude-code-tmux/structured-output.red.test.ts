import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createClaudeCodeTmuxDriver } from '../../../src/drivers/claude-code-tmux/driver'
import { buildClaudeHookSettingsOverlay } from '../../../src/drivers/claude-code-tmux/driver'
import type { ClaudeCodeHookEnvelope } from '../../../src/drivers/claude-code-tmux/hook-events'
import type { DriverContext } from '../../../src/drivers/driver'
import { listenForHookEnvelopes } from '../../../src/drivers/tmux-shared'

type TmuxExecCall = {
  argv: string[]
  env?: Record<string, string | undefined> | undefined
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

type HookHandler = (envelope: ClaudeCodeHookEnvelope) => Promise<void>

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
  invocationId: 'inv_claude_structured',
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
    inputId,
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
    calls.push({ argv, env: options?.env })
    if (argv.includes('display-message')) {
      return {
        stdout: `${paneLease.sessionId}\t${paneLease.windowId}\t${paneLease.paneId}\n`,
        stderr: '',
      }
    }
    if (argv.includes('set-buffer')) {
      pendingLine = argv.at(-1) ?? ''
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
        return {
          socketPath: '/tmp/harness-broker/claude-structured-output.sock',
          close: async () => undefined,
        }
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
    .map((call) => call.argv)
    .filter((argv) => argv.includes('send-keys') && argv.includes('-l'))
    .map((argv) => argv.at(-1) ?? '')
}

function completedText(event: InvocationEventEnvelope): string {
  const content = (event.payload as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? ''
}

async function stop(
  hookHandler: HookHandler,
  turnId: string,
  lastAssistantMessage?: string | undefined
) {
  await hookHandler({
    invocationId: 'inv_claude_structured',
    runtimeId: 'runtime-structured',
    generation: 1,
    callbackSocket: '/tmp/harness-broker/claude-structured-output.sock',
    turnId,
    hookData: {
      hook_event_name: 'Stop',
      ...(lastAssistantMessage !== undefined
        ? { last_assistant_message: lastAssistantMessage }
        : {}),
    },
  })
}

describe('claude-code-tmux JSON Schema structured-output RED contract', () => {
  test('1. advertises synthesized per-turn JSON Schema finalResponse capabilities', async () => {
    const { driver } = await setupDriver()

    expect(driver.capabilities().finalResponse).toEqual({
      jsonSchema: true,
      perTurn: true,
      strict: false,
      parsedResult: false,
    })
  })

  test('2. scopes schema prompting per turn and leaves following text turns unstructured', async () => {
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
      callbackSocket: '/tmp/harness-broker/claude-structured-output.sock',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: submitted },
    })

    expect(events.find((event) => event.type === 'turn.started')).toMatchObject({
      turnId: applied.turnId,
      payload: { turnId: applied.turnId },
    })
  })

  test('4. uses a Stop-only decision bridge and keeps ordinary hooks fire-and-forget', async () => {
    const overlay = buildClaudeHookSettingsOverlay({
      callbackSocket: '/tmp/harness-broker/decision.sock',
      bridgeCommand: 'harness-broker claude-hook',
    })
    const hooks = overlay.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>

    // Public settings contract: ordinary hooks keep the fire-and-forget bridge,
    // while Stop alone invokes the stdout-capable decision bridge.
    expect(hooks['PreToolUse']?.[0]?.hooks[0]?.command).toContain('claude-hook ')
    expect(hooks['MessageDisplay']?.[0]?.hooks[0]?.command).toContain('claude-hook ')
    expect(hooks['Stop']?.[0]?.hooks[0]?.command).toContain('claude-hook-decision ')
  })

  test('4. decision socket protocol returns no stdout payload for no-decision and exact JSON for decisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-decision-protocol-'))
    const socketPath = join(root, 'hook.sock')
    try {
      const noDecision = await listenForHookEnvelopes<ClaudeCodeHookEnvelope>(
        socketPath,
        async () => undefined
      )
      const okResponse = await postEnvelopeAndRead(socketPath, {
        invocationId: 'inv_claude_structured',
        generation: 1,
        callbackSocket: socketPath,
        hookData: { hook_event_name: 'Stop' },
      })
      await noDecision.close()
      expect(okResponse).toBe('')

      const decision = { decision: 'block', reason: 'must match schema' }
      const decisionListener = await listenForHookEnvelopes<ClaudeCodeHookEnvelope>(
        socketPath,
        (async () => decision) as unknown as (envelope: ClaudeCodeHookEnvelope) => Promise<void>
      )
      const decisionResponse = await postEnvelopeAndRead(socketPath, {
        invocationId: 'inv_claude_structured',
        generation: 1,
        callbackSocket: socketPath,
        hookData: { hook_event_name: 'Stop' },
      })
      await decisionListener.close()
      expect(decisionResponse).toBe(JSON.stringify(decision))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('5. validates bare JSON and a whole-message fenced block, emitting normalized JSON once', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const bare = await driver.applyInputNow(
      input('input_bare_json', 'return status', schemaResponse(statusSchema))
    )
    await stop(hookHandler, bare.turnId ?? 'missing', '{"status":"ok"}')

    const fenced = await driver.applyInputNow(
      input('input_fenced_json', 'return count', schemaResponse(countSchema))
    )
    await stop(hookHandler, fenced.turnId ?? 'missing', '```json\n{"count":7}\n```')

    const finals = events.filter((event) => event.type === 'assistant.message.completed')
    const completions = events.filter((event) => event.type === 'turn.completed')
    expect(finals).toHaveLength(2)
    expect(completions).toHaveLength(2)
    expect(finals.map(completedText)).toEqual(['{"status":"ok"}', '{"count":7}'])
    for (const finalText of finals.map(completedText)) {
      expect(() => JSON.parse(finalText)).not.toThrow()
      expect(finalText).not.toContain('```')
    }
  })

  test('6. accepts leading prose before a valid JSON object and emits normalized JSON only', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_prefixed_json', 'return status', schemaResponse(statusSchema))
    )
    await stop(hookHandler, applied.turnId ?? 'missing', 'Here is the JSON:\n{"status":"ok"}')

    const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
    const finals = sameTurnEvents.filter((event) => event.type === 'assistant.message.completed')
    const completions = sameTurnEvents.filter((event) => event.type === 'turn.completed')
    expect(finals).toHaveLength(1)
    expect(completions).toHaveLength(1)
    expect(completedText(finals[0] as InvocationEventEnvelope)).toBe('{"status":"ok"}')
  })

  test('7. prefix extraction validates the first JSON root and fails closed on invalid candidates', async () => {
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

    for (const applied of [schemaInvalid, noRoot, laterValid]) {
      const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
      expect(sameTurnEvents.map((event) => event.type)).not.toContain('assistant.message.completed')
      expect(sameTurnEvents.map((event) => event.type)).not.toContain('turn.completed')
    }
  })

  test('8. prefix extraction rejects trailing wrapper prose after the JSON root', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_prefixed_suffix', 'return status', schemaResponse(statusSchema))
    )
    await stop(
      hookHandler,
      applied.turnId ?? 'missing',
      'Here is the JSON:\n{"status":"ok"}\nThanks'
    )

    const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
    expect(sameTurnEvents.map((event) => event.type)).not.toContain('assistant.message.completed')
    expect(sameTurnEvents.map((event) => event.type)).not.toContain('turn.completed')
  })

  test('9. prefix extraction handles braces and brackets inside JSON strings', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_prefixed_strings', 'return status', schemaResponse(statusSchema))
    )
    await stop(
      hookHandler,
      applied.turnId ?? 'missing',
      'Here is the JSON:\n{"status":"ok with {braces} and [brackets]"}'
    )

    const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
    const finals = sameTurnEvents.filter((event) => event.type === 'assistant.message.completed')
    expect(finals).toHaveLength(1)
    expect(completedText(finals[0] as InvocationEventEnvelope)).toBe(
      '{"status":"ok with {braces} and [brackets]"}'
    )
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

  test('12. terminal paths without validator clearance fail closed instead of completing invalid content', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_delivery_miss', 'return status', schemaResponse(statusSchema))
    )
    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-structured-output.sock',
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
      callbackSocket: '/tmp/harness-broker/claude-structured-output.sock',
      turnId: applied.turnId,
      hookData: { hook_event_name: 'SessionEnd', reason: 'other' },
    })

    const sameTurnEvents = events.filter((event) => event.turnId === applied.turnId)
    expect(sameTurnEvents.map((event) => event.type)).not.toContain('assistant.message.completed')
    expect(sameTurnEvents.map((event) => event.type)).not.toContain('turn.completed')
  })

  test('13. late terminal MessageDisplay after structured Stop does not emit another assistant completion', async () => {
    const { driver, events, hookHandler } = await setupDriver()

    const applied = await driver.applyInputNow(
      input('input_late_display', 'return status', schemaResponse(statusSchema))
    )
    await stop(hookHandler, applied.turnId ?? 'missing', '{"status":"ok"}')
    const terminalCount = events.filter(
      (event) => event.type === 'assistant.message.completed'
    ).length

    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-structured-output.sock',
      turnId: applied.turnId,
      hookData: {
        hook_event_name: 'MessageDisplay',
        message_id: 'msg_late',
        index: 0,
        final: true,
        delta: '{"status":"late"}',
      },
    })
    await hookHandler({
      invocationId: 'inv_claude_structured',
      runtimeId: 'runtime-structured',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-structured-output.sock',
      turnId: applied.turnId,
      hookData: {
        hook_event_name: 'PreToolUse',
        tool_use_id: 'toolu_late',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      },
    })

    expect(events.filter((event) => event.type === 'assistant.message.completed')).toHaveLength(
      terminalCount
    )
  })
})

async function postEnvelopeAndRead(socketPath: string, envelope: ClaudeCodeHookEnvelope) {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const conn = connect(socketPath)
    conn.on('error', reject)
    conn.on('data', (chunk: Buffer) => chunks.push(chunk))
    conn.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    conn.on('connect', () => conn.end(JSON.stringify(envelope)))
  })
}
