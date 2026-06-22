import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

const invocationId = 'inv_claude_hooktx_1'

type ClaudeHookTranscriptReader = {
  handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
  drain: () => InvocationEventEnvelope[]
  reset: () => void
}

type ClaudeHookTranscriptReaderFactory = (options: {
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
}) => ClaudeHookTranscriptReader

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const loadFactory = async (): Promise<ClaudeHookTranscriptReaderFactory> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/hook-transcript')) as {
    createClaudeHookTranscriptReader: ClaudeHookTranscriptReaderFactory
  }
  return target.createClaudeHookTranscriptReader
}

const tempTranscript = (name = 'session.jsonl'): string => {
  const root = mkdtempSync(join(tmpdir(), 'claude-hooktx-'))
  tempRoots.push(root)
  const path = join(root, name)
  writeFileSync(path, '')
  return path
}

const jsonl = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`

const enqueue = (content: string): string =>
  jsonl({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-06-07T22:33:03.226Z',
    sessionId: '8f97fc3c',
    content,
  })

const removeOp = (content: string): string =>
  jsonl({
    type: 'queue-operation',
    operation: 'remove',
    timestamp: '2026-06-07T22:33:05.000Z',
    sessionId: '8f97fc3c',
    content,
  })

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
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

const messageOf = (event: InvocationEventEnvelope): string =>
  (event.payload as { message?: string }).message ?? ''

const dataOf = (event: InvocationEventEnvelope): Record<string, unknown> =>
  (event.payload as { data?: Record<string, unknown> }).data ?? {}

const sessionStart = (transcriptPath: string): Record<string, unknown> => ({
  hook_event_name: 'SessionStart',
  transcript_path: transcriptPath,
})

const postToolUse = (): Record<string, unknown> => ({
  hook_event_name: 'PostToolUse',
  tool_use_id: 'call_1',
  tool_name: 'Bash',
})

const stop = (): Record<string, unknown> => ({ hook_event_name: 'Stop' })

const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

const contentOf = (event: InvocationEventEnvelope): string =>
  (event.payload as { content?: string }).content ?? ''

describe('createClaudeHookTranscriptReader', () => {
  test('emits one user.message for a mid-turn queue/enqueue line, attributed to the live turn', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-07T22:33:04.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    // SessionStart records the transcript path, emits nothing.
    expect(reader.handleHook(sessionStart(path))).toEqual([])

    // The mid-turn steered prompt's ONLY record is queue-operation/enqueue.
    appendFileSync(path, enqueue('GHOSTE2E_PROMPT_PROBE reply with exactly OK'))

    const events = reader.handleHook(postToolUse())
    expect(eventTypes(events)).toEqual(['user.message'])
    expect(contentOf(events[0]!)).toBe('GHOSTE2E_PROMPT_PROBE reply with exactly OK')
    expect(events[0]!.turnId).toBe('turn_active_1')
    expect((events[0]!.payload as { turnId?: string }).turnId).toBe('turn_active_1')
  })

  test('idle prompts (type:user, no enqueue) emit nothing — no double-count', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-07T22:33:04.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))
    // An idle prompt lands as a type:user entry (UserPromptSubmit handles it on a
    // disjoint channel). The transcript reader must NOT re-emit it.
    appendFileSync(path, userEntry('an idle prompt typed while agent was idle'))

    const events = reader.handleHook(stop())
    expect(events).toEqual([])
  })

  test('queue/remove (dequeue) emits nothing — only enqueue surfaces a prompt', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-07T22:33:04.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))
    appendFileSync(path, removeOp('GHOSTE2E_PROMPT_PROBE reply with exactly OK'))

    expect(reader.handleHook(postToolUse())).toEqual([])
  })

  test('skips empty enqueue content', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-07T22:33:04.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))
    appendFileSync(path, enqueue(''))

    expect(reader.handleHook(postToolUse())).toEqual([])
  })

  test('omits turnId when no turn is active', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-07T22:33:04.000Z'),
      invocationId,
      getCurrentTurnId: () => undefined,
    })

    reader.handleHook(sessionStart(path))
    appendFileSync(path, enqueue('a steered prompt with no active turn'))

    const events = reader.handleHook(postToolUse())
    expect(eventTypes(events)).toEqual(['user.message'])
    expect(events[0]!.turnId).toBeUndefined()
    expect((events[0]!.payload as { turnId?: string }).turnId).toBeUndefined()
  })

  test('two mid-turn enqueues across separate hooks emit one user.message each', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-07T22:33:04.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))

    appendFileSync(path, enqueue('first steered prompt'))
    const first = reader.handleHook(postToolUse())
    expect(eventTypes(first)).toEqual(['user.message'])
    expect(contentOf(first[0]!)).toBe('first steered prompt')

    appendFileSync(path, enqueue('second steered prompt'))
    const second = reader.handleHook(postToolUse())
    expect(eventTypes(second)).toEqual(['user.message'])
    expect(contentOf(second[0]!)).toBe('second steered prompt')
  })

  test('byte-offset tailing preserves partial-line buffering, multi-record order, and offset resume', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-07T22:33:04.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))
    appendFileSync(
      path,
      '{"type":"queue-operation","operation":"enqueue","content":"partial prompt"'
    )

    // T-04627 characterization: bytes without a newline advance the read offset
    // but remain buffered; the next hook must not emit a partial JSON record.
    expect(reader.handleHook(postToolUse())).toEqual([])

    appendFileSync(
      path,
      '}\n{"type":"queue-operation","operation":"enqueue","content":"second prompt"}\n{"type":"queue-operation","operation":"remove","content":"not emitted"}\n'
    )
    const firstRead = reader.handleHook(postToolUse())

    expect(eventTypes(firstRead)).toEqual(['user.message', 'user.message'])
    expect(firstRead.map(contentOf)).toEqual(['partial prompt', 'second prompt'])

    // Offset resume guard: already-read complete records are not replayed.
    expect(reader.handleHook(postToolUse())).toEqual([])

    appendFileSync(
      path,
      '{"type":"queue-operation","operation":"enqueue","content":"third prompt"}\n'
    )
    const resumed = reader.handleHook(postToolUse())

    expect(eventTypes(resumed)).toEqual(['user.message'])
    expect(resumed.map(contentOf)).toEqual(['third prompt'])
  })

  // T-05092: API-failure rows → non-terminal diagnostic (daedalus DM #9988).
  test('emits one diagnostic for an assistant isApiErrorMessage row, with approved shape', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-22T19:34:10.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))
    appendFileSync(path, apiError('API Error: Internal server error'))

    const events = reader.handleHook(postToolUse())
    expect(eventTypes(events)).toEqual(['diagnostic'])
    const event = events[0]!
    expect(event.payload).toMatchObject({ level: 'error', source: 'harness' })
    expect(messageOf(event)).toBe('API Error: Internal server error')
    expect(dataOf(event)).toMatchObject({
      code: 'api_error',
      rawType: 'assistant',
      isApiErrorMessage: true,
      requestId: 'req_011CcJrh',
      error: 'unknown',
    })
    // code lives under data, never top-level (no DiagnosticPayload widening).
    expect((event.payload as { code?: unknown }).code).toBeUndefined()
    // driver provenance + active turn id.
    expect(event.driver).toEqual({ kind: 'claude-code-tmux', rawType: 'assistant' })
    expect(event.turnId).toBe('turn_active_1')
    expect((event.payload as { turnId?: string }).turnId ?? 'turn_active_1').toBe('turn_active_1')
  })

  test('carries apiErrorStatus when the row has a numeric status', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-22T19:34:10.000Z'),
      invocationId,
      getCurrentTurnId: () => undefined,
    })

    reader.handleHook(sessionStart(path))
    appendFileSync(path, apiError('API Error: Overloaded', { status: 529, requestId: 'req_x' }))

    const events = reader.handleHook(postToolUse())
    expect(eventTypes(events)).toEqual(['diagnostic'])
    expect(dataOf(events[0]!)).toMatchObject({ code: 'api_error', apiErrorStatus: 529 })
    // No active turn → no turnId required.
    expect(events[0]!.turnId).toBeUndefined()
  })

  test('non-API assistant rows, false flag, empty text, and malformed JSON emit nothing', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-22T19:34:10.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))
    // Ordinary assistant content — not an API error.
    appendFileSync(path, assistantOk('Here is the answer.'))
    // Flag explicitly false.
    appendFileSync(
      path,
      jsonl({
        type: 'assistant',
        isApiErrorMessage: false,
        message: { content: [{ type: 'text', text: 'not an error' }] },
      })
    )
    // Malformed JSON line.
    appendFileSync(path, 'this is not json\n')

    expect(reader.handleHook(postToolUse())).toEqual([])
  })

  test('empty API-error text falls back to a non-empty diagnostic message', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-22T19:34:10.000Z'),
      invocationId,
      getCurrentTurnId: () => undefined,
    })

    reader.handleHook(sessionStart(path))
    appendFileSync(
      path,
      jsonl({ type: 'assistant', isApiErrorMessage: true, message: { content: [] } })
    )

    const events = reader.handleHook(postToolUse())
    expect(eventTypes(events)).toEqual(['diagnostic'])
    expect(messageOf(events[0]!)).toBe('Claude Code API error')
  })

  test('stop()-style drain emits an unread API-error row exactly once; no replay after a prior read', async () => {
    const create = await loadFactory()
    const path = tempTranscript()
    const reader = create({
      now: () => new Date('2026-06-22T19:34:10.000Z'),
      invocationId,
      getCurrentTurnId: () => 'turn_active_1',
    })

    reader.handleHook(sessionStart(path))

    // Row written with no triggering hook after it: drain() surfaces it.
    appendFileSync(path, apiError('API Error: Internal server error'))
    const drained = reader.drain()
    expect(eventTypes(drained)).toEqual(['diagnostic'])
    expect(messageOf(drained[0]!)).toBe('API Error: Internal server error')

    // The byte-offset tailer is the dedupe mechanism: a second drain replays nothing.
    expect(reader.drain()).toEqual([])

    // A row already consumed by a hook read is not re-emitted by a later drain.
    appendFileSync(path, apiError('API Error: second', { requestId: 'req_2' }))
    expect(eventTypes(reader.handleHook(postToolUse()))).toEqual(['diagnostic'])
    expect(reader.drain()).toEqual([])
  })
})
