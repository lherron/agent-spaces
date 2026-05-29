import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

const invocationId = 'inv_codex_hooktx_1'

type CodexHookTranscriptReader = {
  handleHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
  reset: () => void
}

type CodexHookTranscriptReaderFactory = (options: {
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
}) => CodexHookTranscriptReader

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const loadFactory = async (): Promise<CodexHookTranscriptReaderFactory> => {
  const target = (await import('../../../src/drivers/codex-cli-tmux/hook-transcript')) as {
    createCodexHookTranscriptReader: CodexHookTranscriptReaderFactory
  }
  return target.createCodexHookTranscriptReader
}

const tempTranscript = (name = 'rollout.jsonl'): string => {
  const root = mkdtempSync(join(tmpdir(), 'codex-hooktx-'))
  tempRoots.push(root)
  const path = join(root, name)
  writeFileSync(path, '')
  return path
}

const jsonl = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`

const agentMessage = (message: string, extra: Record<string, unknown> = {}): string =>
  jsonl({
    timestamp: '2026-05-27T17:30:00.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message, ...extra },
  })

const agentMessageDelta = (delta: string, extra: Record<string, unknown> = {}): string =>
  jsonl({
    timestamp: '2026-05-27T17:30:00.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message_delta', delta, ...extra },
  })

const taskComplete = (extra: Record<string, unknown> = {}): string =>
  jsonl({
    timestamp: '2026-05-27T17:30:03.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', ...extra },
  })

const sessionStart = (transcriptPath: string): Record<string, unknown> => ({
  hook_event_name: 'SessionStart',
  transcript_path: transcriptPath,
})

const preToolUse = (): Record<string, unknown> => ({
  hook_event_name: 'PreToolUse',
  tool_use_id: 'call_1',
  tool_name: 'Bash',
})

const postToolUse = (): Record<string, unknown> => ({
  hook_event_name: 'PostToolUse',
  tool_use_id: 'call_1',
  tool_name: 'Bash',
})

const stop = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: 'Stop',
  ...extra,
})

const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

const text = (event: InvocationEventEnvelope): string => {
  const content = event.payload['content'] as Array<{ text?: string }> | undefined
  return content?.[0]?.text ?? ''
}

const finals = (events: InvocationEventEnvelope[]): (boolean | undefined)[] =>
  events.map((event) => event.payload['final'] as boolean | undefined)

const createHarness = async () => {
  const factory = await loadFactory()
  let turnId: string | undefined = 'turn_codex_1'
  const reader = factory({
    now: () => new Date('2026-05-27T17:31:00.000Z'),
    invocationId,
    getCurrentTurnId: () => turnId,
  })
  return {
    reader,
    setTurnId: (next: string | undefined) => {
      turnId = next
    },
  }
}

describe('codex-cli-tmux hook-driven transcript reader', () => {
  test('SessionStart records the path and reads no events', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()
    expect(reader.handleHook(sessionStart(path))).toEqual([])
  })

  test('single-message terminal turn: held agent_message flushes final:true on Stop', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(path))
    appendFileSync(path, agentMessage('only answer', { id: 'rollout_msg_a' }))
    appendFileSync(path, taskComplete({ last_agent_message: 'only answer' }))

    const events = reader.handleHook(stop({ last_assistant_message: 'only answer' }))

    expect(eventTypes(events)).toEqual(['assistant.message.completed'])
    expect(events[0]).toMatchObject({
      invocationId,
      turnId: 'turn_codex_1',
      itemId: 'rollout_msg_a',
      type: 'assistant.message.completed',
      driver: { kind: 'codex-cli-tmux', rawType: 'agent_message' },
      payload: {
        messageId: 'rollout_msg_a',
        content: [{ type: 'text', text: 'only answer' }],
        final: true,
      },
    })
  })

  test('multi-message narration: interim final:false emits mid-stream before the terminal final:true', async () => {
    const path = tempTranscript()
    const harness = await createHarness()
    const { reader } = harness

    reader.handleHook(sessionStart(path))

    // First interim arrives before the first tool call; the tool boundary proves
    // it is non-terminal, so it flushes before the normalized tool event.
    appendFileSync(path, agentMessage('first note', { id: 'rollout_msg_a' }))
    const onFirstPre = reader.handleHook(preToolUse())
    expect(eventTypes(onFirstPre)).toEqual(['assistant.message.completed'])
    expect(onFirstPre[0]).toMatchObject({
      turnId: 'turn_codex_1',
      itemId: 'rollout_msg_a',
      payload: {
        messageId: 'rollout_msg_a',
        content: [{ type: 'text', text: 'first note' }],
        final: false,
      },
    })
    expect(reader.handleHook(postToolUse())).toEqual([])

    // Second interim arrives before the next tool call and likewise flushes
    // as final:false BEFORE this hook's normalized tool event (driver ordering).
    harness.setTurnId('turn_codex_2')
    appendFileSync(path, agentMessage('second note'))
    const onSecondPre = reader.handleHook(preToolUse())
    expect(eventTypes(onSecondPre)).toEqual(['assistant.message.completed'])
    expect(onSecondPre[0]).toMatchObject({
      turnId: 'turn_codex_2',
      itemId: `msg_${invocationId}_1`,
      payload: {
        messageId: `msg_${invocationId}_1`,
        content: [{ type: 'text', text: 'second note' }],
        final: false,
      },
    })

    // Terminal answer + task_complete; Stop flushes the terminal exactly once.
    harness.setTurnId('turn_codex_3')
    appendFileSync(path, agentMessage('final note'))
    appendFileSync(path, taskComplete({ last_agent_message: 'final note' }))
    const onStop = reader.handleHook(stop({ last_assistant_message: 'final note' }))

    expect(eventTypes(onStop)).toEqual(['assistant.message.completed'])
    expect(finals(onStop)).toEqual([true])
    expect(onStop[0]).toMatchObject({
      turnId: 'turn_codex_3',
      itemId: `msg_${invocationId}_2`,
      payload: { content: [{ type: 'text', text: 'final note' }], final: true },
    })

    const all = [...onFirstPre, ...onSecondPre, ...onStop]
    expect(eventTypes(all)).not.toContain('assistant.message.started')
    expect(eventTypes(all)).not.toContain('assistant.message.delta')
    expect(finals(all)).toEqual([false, false, true])
  })

  test('coalesces agent_message_delta chunks by message id into one completed message', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(path))
    appendFileSync(path, agentMessageDelta('Hel', { id: 'm1', index: 0 }))
    appendFileSync(path, agentMessageDelta('lo ', { id: 'm1', index: 1 }))
    appendFileSync(path, agentMessageDelta('world', { id: 'm1', index: 2 }))
    // No consolidated agent_message; deltas complete at Stop.
    const events = reader.handleHook(stop())

    expect(eventTypes(events)).toEqual(['assistant.message.completed'])
    expect(events[0]).toMatchObject({
      itemId: 'm1',
      payload: { messageId: 'm1', content: [{ type: 'text', text: 'Hello world' }], final: true },
    })
  })

  test('a consolidated agent_message supersedes its own streamed deltas (no double emission)', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(path))
    appendFileSync(path, agentMessageDelta('Hel', { id: 'm1', index: 0 }))
    appendFileSync(path, agentMessageDelta('lo', { id: 'm1', index: 1 }))
    appendFileSync(path, agentMessage('Hello world', { id: 'm1' }))
    const events = reader.handleHook(stop({ last_assistant_message: 'Hello world' }))

    expect(eventTypes(events)).toEqual(['assistant.message.completed'])
    expect(events[0]).toMatchObject({
      itemId: 'm1',
      payload: { content: [{ type: 'text', text: 'Hello world' }], final: true },
    })
  })

  test('transcript path change resets offset and discards a held message from the old path', async () => {
    const pathA = tempTranscript('a.jsonl')
    const pathB = tempTranscript('b.jsonl')
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(pathA))
    appendFileSync(pathA, agentMessage('stale from A', { id: 'a1' }))
    // A non-tool hook reads and holds the message without flushing it.
    expect(reader.handleHook({ hook_event_name: 'UserPromptSubmit' })).toEqual([])

    // New session/transcript: held state from A must be discarded.
    reader.handleHook(sessionStart(pathB))
    appendFileSync(pathB, agentMessage('B interim', { id: 'b1' }))
    appendFileSync(pathB, agentMessage('B final', { id: 'b2' }))
    const events = reader.handleHook(stop({ last_assistant_message: 'B final' }))

    expect(events.every((event) => text(event) !== 'stale from A')).toBe(true)
    expect(eventTypes(events)).toEqual([
      'assistant.message.completed',
      'assistant.message.completed',
    ])
    expect(events.map(text)).toEqual(['B interim', 'B final'])
    expect(finals(events)).toEqual([false, true])
  })

  test('terminal fallback via task_complete.last_agent_message when no agent_message line exists', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(path))
    appendFileSync(path, taskComplete({ last_agent_message: 'completed via task_complete' }))
    // Stop hook itself carries no last_assistant_message.
    const events = reader.handleHook(stop())

    expect(eventTypes(events)).toEqual(['assistant.message.completed'])
    expect(events[0]).toMatchObject({
      payload: { content: [{ type: 'text', text: 'completed via task_complete' }], final: true },
    })
  })

  test('terminal fallback via Stop.last_assistant_message when the transcript is empty', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(path))
    const events = reader.handleHook(stop({ last_assistant_message: 'answer from Stop hook' }))

    expect(eventTypes(events)).toEqual(['assistant.message.completed'])
    expect(events[0]).toMatchObject({
      payload: { content: [{ type: 'text', text: 'answer from Stop hook' }], final: true },
    })
  })

  test('held terminal flushes exactly once on Stop and is not duplicated by last_assistant_message', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(path))
    appendFileSync(path, agentMessage('the answer', { id: 'm9' }))
    const events = reader.handleHook(stop({ last_assistant_message: 'the answer' }))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      payload: { messageId: 'm9', content: [{ type: 'text', text: 'the answer' }], final: true },
    })
  })

  test('no timer, no sleeps: events are returned synchronously from handleHook', async () => {
    const path = tempTranscript()
    const { reader } = await createHarness()

    reader.handleHook(sessionStart(path))
    appendFileSync(path, agentMessage('immediate', { id: 'm0' }))
    // No await, no settle: the Stop hook reads and returns in the same tick.
    const events = reader.handleHook(stop({ last_assistant_message: 'immediate' }))
    expect(events).toHaveLength(1)
    expect(text(events[0] as InvocationEventEnvelope)).toBe('immediate')
  })
})
