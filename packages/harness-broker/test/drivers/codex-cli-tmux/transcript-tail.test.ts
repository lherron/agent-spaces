import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

const invocationId = 'inv_codex_tail_1'

type CodexTranscriptTailer = {
  start: (transcriptPath: string) => void
  stop: () => void
}

type CodexTranscriptTailerFactory = (options: {
  emit: (event: InvocationEventEnvelope) => void
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
}) => CodexTranscriptTailer

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const loadCreateTailer = async (): Promise<CodexTranscriptTailerFactory> => {
  const target = (await import('../../../src/drivers/codex-cli-tmux/transcript-tail')) as {
    createCodexTranscriptTailer: CodexTranscriptTailerFactory
  }
  return target.createCodexTranscriptTailer
}

const createTempTranscriptPath = async (name = 'rollout.jsonl'): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'codex-transcript-tail-'))
  tempRoots.push(root)
  return join(root, name)
}

const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`

const agentMessage = (
  message: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  timestamp: '2026-05-27T17:30:00.000Z',
  type: 'event_msg',
  payload: { type: 'agent_message', message, ...extra },
})

const taskComplete = (): Record<string, unknown> => ({
  timestamp: '2026-05-27T17:30:03.000Z',
  type: 'event_msg',
  payload: { type: 'task_complete' },
})

const taskStarted = (): Record<string, unknown> => ({
  timestamp: '2026-05-27T17:30:00.000Z',
  type: 'event_msg',
  payload: { type: 'task_started' },
})

const responseItem = (): Record<string, unknown> => ({
  timestamp: '2026-05-27T17:30:01.000Z',
  type: 'response_item',
  payload: { type: 'message', content: 'not a rollout agent_message' },
})

const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

const messageTexts = (events: InvocationEventEnvelope[]): string[] =>
  events.map((event) => {
    const content = event.payload['content']
    expect(content).toEqual(expect.any(Array))
    return (content as Array<{ type: 'text'; text: string }>)[0]?.text ?? ''
  })

const waitFor = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000
): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

const createHarness = async () => {
  const events: InvocationEventEnvelope[] = []
  let turnId: string | undefined = 'turn_codex_1'
  const createTailer = await loadCreateTailer()
  const tailer = createTailer({
    emit: (event) => events.push(event),
    now: () => new Date('2026-05-27T17:31:00.000Z'),
    invocationId,
    getCurrentTurnId: () => turnId,
  })
  return {
    events,
    tailer,
    setTurnId: (next: string | undefined) => {
      turnId = next
    },
  }
}

describe('codex-cli-tmux transcript tailing', () => {
  test('holds the latest agent_message, emits intermediates in real time, and finalizes on task_complete', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(agentMessage('first note', { id: 'rollout_msg_a' })))
    await settle()
    expect(harness.events).toEqual([])

    harness.setTurnId('turn_codex_2')
    await appendFile(transcriptPath, line(agentMessage('second note')))
    await waitFor(() => harness.events.length === 1, 'first message was not emitted in real time')
    expect(harness.events[0]).toMatchObject({
      invocationId,
      turnId: 'turn_codex_2',
      itemId: 'rollout_msg_a',
      type: 'assistant.message.completed',
      driver: { kind: 'codex-cli-tmux', rawType: 'agent_message' },
      payload: {
        messageId: 'rollout_msg_a',
        content: [{ type: 'text', text: 'first note' }],
        final: false,
      },
    })

    harness.setTurnId('turn_codex_3')
    await appendFile(transcriptPath, line(agentMessage('final note')))
    await waitFor(() => harness.events.length === 2, 'second message was not emitted before task_complete')

    await appendFile(transcriptPath, line(taskComplete()))
    await waitFor(() => harness.events.length === 3, 'held final message was not emitted on task_complete')
    harness.tailer.stop()

    expect(eventTypes(harness.events)).toEqual([
      'assistant.message.completed',
      'assistant.message.completed',
      'assistant.message.completed',
    ])
    expect(messageTexts(harness.events)).toEqual(['first note', 'second note', 'final note'])
    expect(harness.events.map((event) => event.payload['final'])).toEqual([false, false, true])
    expect(harness.events[1]).toMatchObject({
      turnId: 'turn_codex_3',
      itemId: `msg_${invocationId}_1`,
      payload: { messageId: `msg_${invocationId}_1` },
    })
    expect(harness.events[2]).toMatchObject({
      turnId: 'turn_codex_3',
      itemId: `msg_${invocationId}_2`,
      payload: {
        messageId: `msg_${invocationId}_2`,
        content: [{ type: 'text', text: 'final note' }],
        final: true,
      },
    })
    expect(eventTypes(harness.events)).not.toContain('assistant.message.started')
    expect(eventTypes(harness.events)).not.toContain('assistant.message.delta')
  })

  test('buffers trailing partial JSONL until the newline completes the line', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(agentMessage('complete first')))
    await appendFile(transcriptPath, JSON.stringify(agentMessage('partial second')))
    await settle()
    expect(harness.events).toEqual([])

    await appendFile(transcriptPath, '\n')
    await waitFor(() => harness.events.length === 1, 'completed partial line did not release held message')
    harness.tailer.stop()

    expect(harness.events[0]).toMatchObject({
      type: 'assistant.message.completed',
      payload: {
        content: [{ type: 'text', text: 'complete first' }],
        final: false,
      },
    })
  })

  test('start before the transcript exists does not throw and begins tailing when it appears', async () => {
    const transcriptPath = await createTempTranscriptPath('nested/rollout.jsonl')
    const harness = await createHarness()

    expect(() => harness.tailer.start(transcriptPath)).not.toThrow()
    await mkdir(join(transcriptPath, '..'), { recursive: true })
    await writeFile(transcriptPath, line(agentMessage('appeared first')))
    await settle()
    expect(harness.events).toEqual([])

    await appendFile(transcriptPath, line(agentMessage('appeared second')))
    await waitFor(() => harness.events.length === 1, 'tailer did not pick up a newly-created transcript')
    harness.tailer.stop()

    expect(harness.events[0]).toMatchObject({
      type: 'assistant.message.completed',
      payload: {
        content: [{ type: 'text', text: 'appeared first' }],
        final: false,
      },
    })
  })

  test('duplicate start calls do not double-tail or double-emit', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(agentMessage('one')))
    await appendFile(transcriptPath, line(agentMessage('two')))
    await waitFor(() => harness.events.length === 1, 'held message was not emitted')
    await settle()
    harness.tailer.stop()

    expect(harness.events).toHaveLength(1)
    expect(messageTexts(harness.events)).toEqual(['one'])
  })

  test('task_complete and stop emit the held final agent_message exactly once', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(agentMessage('only final')))
    await appendFile(transcriptPath, line(taskComplete()))
    await waitFor(() => harness.events.length === 1, 'final message was not emitted on task_complete')
    harness.tailer.stop()
    await settle()

    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toMatchObject({
      type: 'assistant.message.completed',
      payload: {
        content: [{ type: 'text', text: 'only final' }],
        final: true,
      },
    })
  })

  test('ignores non-agent_message event_msg lines and response_item lines', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(taskStarted()))
    await appendFile(transcriptPath, line(responseItem()))
    await appendFile(transcriptPath, line({ type: 'event_msg', payload: { type: 'token_count' } }))
    await appendFile(transcriptPath, line(taskComplete()))
    await settle()
    harness.tailer.stop()

    expect(harness.events).toEqual([])
  })
})
