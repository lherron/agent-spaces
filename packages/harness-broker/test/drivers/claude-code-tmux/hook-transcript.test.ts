import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

const invocationId = 'inv_claude_hooktx_1'

type ClaudeHookTranscriptReader = {
  handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
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
})
