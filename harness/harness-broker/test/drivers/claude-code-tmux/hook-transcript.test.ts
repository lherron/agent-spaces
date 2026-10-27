import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventFor,
  InvocationEventType,
} from 'spaces-harness-broker-protocol'
import type { ClaudeHookTranscriptReaderOptions } from '../../../src/drivers/claude-code-tmux/hook-transcript'
import { invocationIdFrom } from '../../ids'
import { startHookDriver } from './driver-red.helpers'

const invocationId = 'inv_claude_hooktx_1'

/**
 * Test-local view of the reader. The production reader EMITS through an
 * injected callback (so events carry the provenance of the raw row that
 * produced them); this wrapper collects what each call emitted and returns it,
 * which is the shape these behaviour assertions are written against.
 */
type ClaudeHookTranscriptReader = {
  handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
  drain: () => InvocationEventEnvelope[]
  flushTerminalAssistantMessage: () => InvocationEventEnvelope[]
  reset: () => void
}

type ClaudeHookTranscriptReaderFactory = (
  options: Omit<ClaudeHookTranscriptReaderOptions, 'emit'>
) => ClaudeHookTranscriptReader

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const loadFactory = async (): Promise<ClaudeHookTranscriptReaderFactory> => {
  const target = await import('../../../src/drivers/claude-code-tmux/hook-transcript')
  return (options) => {
    const emitted: InvocationEventEnvelope[] = []
    type EmitExtra = Parameters<ClaudeHookTranscriptReaderOptions['emit']>[2]
    function collect<K extends InvocationEventType>(
      event: InvocationEventFor<K>,
      extra: EmitExtra
    ): void
    function collect(event: InvocationEvent, extra: EmitExtra): void {
      emitted.push({
        invocationId: invocationIdFrom(options.invocationId),
        seq: emitted.length + 1,
        time: new Date(0).toISOString(),
        ...event,
        ...extra,
      })
    }
    const reader = target.createClaudeHookTranscriptReader({
      ...options,
      emit: (type, payload, extra) => collect({ type, payload }, extra),
    })
    const take = (): InvocationEventEnvelope[] => emitted.splice(0)
    return {
      handleHook: (hook) => {
        reader.handleHook(hook)
        return take()
      },
      drain: () => {
        reader.drain()
        return take()
      },
      flushTerminalAssistantMessage: () => {
        reader.flushTerminalAssistantMessage()
        return take()
      },
      reset: () => reader.reset(),
    }
  }
}

const tempTranscript = (name = 'session.jsonl'): string => {
  const root = mkdtempSync(join(tmpdir(), 'claude-hooktx-'))
  tempRoots.push(root)
  const path = join(root, name)
  writeFileSync(path, '')
  return path
}

const jsonl = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`

const userEntry = (textContent: string): string =>
  jsonl({
    type: 'user',
    promptSource: 'typed',
    message: { role: 'user', content: textContent },
  })

// A real CC API-failure row: type:assistant, isApiErrorMessage:true, text nested
// under message.content[], plus top-level requestId/error (see T-05092).
const apiError = (
  text: string,
  extra: Record<string, unknown> = { requestId: 'req_011CcJrh', error: 'unknown' }
): string =>
  jsonl({
    type: 'assistant',
    timestamp: '2026-06-22T19:34:09.815Z',
    message: { role: 'assistant', type: 'message', content: [{ type: 'text', text }] },
    isApiErrorMessage: true,
    ...extra,
  })

const assistantOk = (text: string): string =>
  jsonl({
    type: 'assistant',
    message: {
      id: `msg_${text.replaceAll(/[^a-zA-Z0-9]+/g, '_')}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  })

const messageOf = (event: InvocationEventEnvelope): string =>
  (event.payload as { message?: string }).message ?? ''

const dataOf = (event: InvocationEventEnvelope): Record<string, unknown> =>
  (event.payload as { data?: Record<string, unknown> }).data ?? {}

const sessionStart = (transcriptPath: string): Record<string, unknown> => ({
  hook_event_name: 'SessionStart',
  transcript_path: transcriptPath,
})

const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

const postToolUse = (): Record<string, unknown> => ({
  hook_event_name: 'PostToolUse',
  tool_use_id: 'call_1',
  tool_name: 'Bash',
})

const toolUseRow = (id: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: `msg_${id}`,
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
    },
  })

const toolResultRow = (id: string): string =>
  jsonl({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'listing', is_error: false }],
    },
  })

describe('claude-code-tmux transcript reading through the driver', () => {
  test('a fresh (non-resumed) launch reads its transcript from byte zero', async () => {
    const run = await startHookDriver({
      transcript: userEntry('fresh request') + assistantOk('fresh answer'),
    })
    try {
      await run.hook({ hook_event_name: 'Stop' })

      expect(run.ofType('user.message').map((event) => event.payload)).toEqual([
        expect.objectContaining({ content: 'fresh request' }),
      ])
      expect(run.messages().map((event) => event.payload)).toEqual([
        expect.objectContaining({
          content: [{ type: 'text', text: 'fresh answer' }],
          final: true,
        }),
      ])
    } finally {
      await run.cleanup()
    }
  })

  test('a row split across writes is read once when its line completes, and read rows are never replayed', async () => {
    const run = await startHookDriver()
    try {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_1')
      const toolCalls = () =>
        run.events
          .filter((event) => event.type.startsWith('tool.call.'))
          .map((event) => [event.type, (event.payload as { toolCallId?: string }).toolCallId])

      // T-04627: bytes without a newline stay buffered; no partial record is read.
      const firstRow = toolUseRow('toolu_a')
      appendFileSync(run.transcriptPath, firstRow.slice(0, 40))
      await run.hook(postToolUse(), 'turn_1')
      expect(toolCalls()).toEqual([])

      appendFileSync(run.transcriptPath, `${firstRow.slice(40)}\n${toolResultRow('toolu_a')}`)
      await run.hook(postToolUse(), 'turn_1')
      expect(toolCalls()).toEqual([
        ['tool.call.started', 'toolu_a'],
        ['tool.call.completed', 'toolu_a'],
      ])

      // Offset resume: a hook with nothing new appended replays nothing.
      const before = run.events.length
      await run.hook(postToolUse(), 'turn_1')
      expect(run.events.slice(before)).toEqual([])

      appendFileSync(run.transcriptPath, `${toolUseRow('toolu_b')}\n`)
      await run.hook(postToolUse(), 'turn_1')
      expect(toolCalls()).toEqual([
        ['tool.call.started', 'toolu_a'],
        ['tool.call.completed', 'toolu_a'],
        ['tool.call.started', 'toolu_b'],
      ])
    } finally {
      await run.cleanup()
    }
  })

  test.each([
    {
      case: '429',
      row: apiError('API Error: Too many requests', { status: 429 }),
      turn: true,
      message: 'API Error: Too many requests',
      data: { errorClass: 'rate_limit', apiErrorStatus: 429 },
    },
    {
      case: '529 with no active turn',
      row: apiError('API Error: Overloaded', { status: 529, requestId: 'req_x' }),
      turn: false,
      message: 'API Error: Overloaded',
      data: { errorClass: 'overloaded', apiErrorStatus: 529, requestId: 'req_x' },
    },
    {
      case: '503',
      row: apiError('API Error: Service unavailable', { status: 503 }),
      turn: true,
      message: 'API Error: Service unavailable',
      data: { errorClass: 'server_error', apiErrorStatus: 503 },
    },
    {
      case: '401',
      row: apiError('API Error: Unauthorized', { status: 401 }),
      turn: true,
      message: 'API Error: Unauthorized',
      data: { errorClass: 'auth', apiErrorStatus: 401 },
    },
    {
      case: '402',
      row: apiError('API Error: Payment required', { status: 402 }),
      turn: true,
      message: 'API Error: Payment required',
      data: { errorClass: 'quota', apiErrorStatus: 402 },
    },
    {
      case: 'rate_limit_error',
      row: apiError('API Error', { error: 'rate_limit_error' }),
      turn: true,
      message: 'API Error',
      data: { errorClass: 'rate_limit' },
    },
    {
      case: 'overloaded_error',
      row: apiError('API Error', { error: 'overloaded_error' }),
      turn: true,
      message: 'API Error',
      data: { errorClass: 'overloaded' },
    },
    {
      case: 'internal_server_error',
      row: apiError('API Error', { error: 'internal_server_error' }),
      turn: true,
      message: 'API Error',
      data: { errorClass: 'server_error' },
    },
    {
      case: 'invalid_api_key',
      row: apiError('API Error', { error: 'invalid_api_key' }),
      turn: true,
      message: 'API Error',
      data: { errorClass: 'auth' },
    },
    {
      case: 'credit balance is too low',
      row: apiError('API Error', { error: 'credit balance is too low' }),
      turn: true,
      message: 'API Error',
      data: { errorClass: 'quota' },
    },
    {
      case: 'empty error text',
      row: jsonl({ type: 'assistant', isApiErrorMessage: true, message: { content: [] } }),
      turn: false,
      message: 'Claude Code API error',
      data: {},
    },
  ])(
    'a Claude API-error transcript row is classified by status or error text into rate_limit/overloaded/server_error/auth/quota ($case)',
    async ({ row, turn, message, data }) => {
      const run = await startHookDriver()
      try {
        if (turn) await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_1')
        appendFileSync(run.transcriptPath, row)
        const before = run.events.length
        await run.hook(postToolUse(), turn ? 'turn_1' : undefined)

        const emitted = run.events.slice(before)
        expect(eventTypes(emitted)).toEqual(['diagnostic'])
        const event = emitted[0] as InvocationEventEnvelope
        expect(event.payload).toMatchObject({ level: 'error', source: 'harness' })
        expect(messageOf(event)).toBe(message)
        expect(dataOf(event)).toMatchObject({ code: 'api_error', isApiErrorMessage: true, ...data })
        expect<string | undefined>(event.turnId).toBe(turn ? 'turn_1' : undefined)
      } finally {
        await run.cleanup()
      }
    }
  )

  test('a transcript row that is not JSON is reported as a capture.warning, never dropped', async () => {
    const run = await startHookDriver()
    try {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_1')
      appendFileSync(
        run.transcriptPath,
        [
          assistantOk('Here is the answer.'),
          jsonl({
            type: 'assistant',
            isApiErrorMessage: false,
            message: { content: [{ type: 'text', text: 'not an error' }] },
          }),
          'this is not json\n',
        ].join('')
      )
      await run.hook(postToolUse(), 'turn_1')

      // Rows that are not API errors raise no diagnostic; the malformed row is
      // reported (law 6d04d5de), not skipped in silence.
      expect(run.ofType('diagnostic')).toEqual([])
      expect(run.ofType('capture.warning').map((event) => event.payload)).toEqual([
        { message: 'Claude transcript row is not valid JSON', raw: 'this is not json' },
      ])
    } finally {
      await run.cleanup()
    }
  })
})

describe('createClaudeHookTranscriptReader', () => {
  test('resumed transcripts retain rows appended after SessionStart but before watcher attachment', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    writeFileSync(path, userEntry('historical request') + assistantOk('historical answer'))
    const observedPrompts: string[] = []
    const reader = create({
      now: () => new Date('2026-09-04T13:40:00.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_resumed_race_1',
      resumeFromTranscriptEnd: true,
      onTranscriptPath: () => {
        appendFileSync(path, userEntry('racing current request') + assistantOk('racing answer'))
      },
      onTranscriptEntry: (entry) => {
        const message = entry['message'] as { content?: unknown } | undefined
        if (typeof message?.content === 'string') observedPrompts.push(message.content)
        return false
      },
    })

    expect(reader.handleHook(sessionStart(path))).toEqual([])
    expect(reader.drain()).toEqual([])
    expect(reader.flushTerminalAssistantMessage()).toEqual([
      expect.objectContaining({
        type: 'assistant.message.completed',
        payload: expect.objectContaining({
          content: [{ type: 'text', text: 'racing answer' }],
          final: true,
        }),
      }),
    ])
    expect(observedPrompts).toEqual(['racing current request'])
    expect(reader.drain()).toEqual([])
  })
})
