import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

const invocationId = 'inv_claude_tail_1'

type ClaudeTranscriptTailer = {
  start: (transcriptPath: string) => void
  handleHook: (hook: Record<string, unknown>) => void
  flushTerminal: () => void
  stop: () => void
}

type ClaudeTranscriptTailerFactory = (options: {
  emit: (event: InvocationEventEnvelope) => void
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
}) => ClaudeTranscriptTailer

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const loadCreateTailer = async (): Promise<ClaudeTranscriptTailerFactory> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/transcript-tail')) as {
    createClaudeTranscriptTailer?: ClaudeTranscriptTailerFactory | undefined
  }
  if (target.createClaudeTranscriptTailer === undefined) {
    throw new Error('createClaudeTranscriptTailer export is required')
  }
  return target.createClaudeTranscriptTailer
}

const createTempTranscriptPath = async (name = 'claude-transcript.jsonl'): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'claude-transcript-tail-'))
  tempRoots.push(root)
  return join(root, name)
}

const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`

const assistantMessage = (
  text: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: 'assistant',
  uuid: extra['uuid'] ?? undefined,
  message: {
    id: extra['messageId'] ?? undefined,
    role: 'assistant',
    content: [{ type: 'text', text }],
  },
})

const userMessage = (): Record<string, unknown> => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'not assistant output' }] },
})

const toolResult = (): Record<string, unknown> => ({
  type: 'tool_result',
  toolUseId: 'toolu_1',
  content: 'not assistant output',
})

const sessionStart = (transcriptPath: string): Record<string, unknown> => ({
  hook_event_name: 'SessionStart',
  transcript_path: transcriptPath,
})

const stopHook = (): Record<string, unknown> => ({
  hook_event_name: 'Stop',
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
  let turnId: string | undefined = 'turn_claude_1'
  const createTailer = await loadCreateTailer()
  const tailer = createTailer({
    emit: (event) => events.push(event),
    now: () => new Date('2026-05-27T18:15:00.000Z'),
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

describe('claude-code-tmux transcript tailing RED', () => {
  test('SessionStart transcript_path starts tailing early; held latest emits N-1 intermediates and one terminal final', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.handleHook(sessionStart(transcriptPath))
    await appendFile(transcriptPath, line(assistantMessage('first natural message', { uuid: 'claude_msg_a' })))
    await settle()
    expect(harness.events).toEqual([])

    harness.setTurnId('turn_claude_2')
    await appendFile(transcriptPath, line(assistantMessage('second natural message')))
    await waitFor(() => harness.events.length === 1, 'first message was not emitted before Stop')
    expect(harness.events[0]).toMatchObject({
      invocationId,
      turnId: 'turn_claude_2',
      itemId: 'claude_msg_a',
      type: 'assistant.message.completed',
      driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
      payload: {
        messageId: 'claude_msg_a',
        content: [{ type: 'text', text: 'first natural message' }],
        final: false,
      },
    })

    harness.setTurnId('turn_claude_3')
    await appendFile(transcriptPath, line(assistantMessage('terminal natural answer')))
    await waitFor(() => harness.events.length === 2, 'second message was not emitted before Stop')

    harness.tailer.handleHook(stopHook())
    await waitFor(() => harness.events.length === 3, 'held final message was not emitted on Stop')
    harness.tailer.stop()

    expect(eventTypes(harness.events)).toEqual([
      'assistant.message.completed',
      'assistant.message.completed',
      'assistant.message.completed',
    ])
    expect(messageTexts(harness.events)).toEqual([
      'first natural message',
      'second natural message',
      'terminal natural answer',
    ])
    expect(harness.events.map((event) => event.payload['final'])).toEqual([false, false, true])
    expect(eventTypes(harness.events)).not.toContain('assistant.message.started')
    expect(eventTypes(harness.events)).not.toContain('assistant.message.delta')
  })

  test('buffers trailing partial JSONL until the newline completes the assistant line', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(assistantMessage('complete first')))
    await appendFile(transcriptPath, JSON.stringify(assistantMessage('partial second')))
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
    const transcriptPath = await createTempTranscriptPath('nested/claude-transcript.jsonl')
    const harness = await createHarness()

    expect(() => harness.tailer.start(transcriptPath)).not.toThrow()
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(transcriptPath, line(assistantMessage('appeared first')))
    await settle()
    expect(harness.events).toEqual([])

    await appendFile(transcriptPath, line(assistantMessage('appeared second')))
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

  test('duplicate starts for the same transcript do not double-tail or double-emit', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(assistantMessage('one')))
    await appendFile(transcriptPath, line(assistantMessage('two')))
    await waitFor(() => harness.events.length === 1, 'held message was not emitted')
    await settle()
    harness.tailer.stop()

    expect(harness.events).toHaveLength(1)
    expect(messageTexts(harness.events)).toEqual(['one'])
  })

  test('Stop and stop() emit the held terminal assistant message exactly once', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(assistantMessage('only terminal')))
    harness.tailer.handleHook(stopHook())
    await waitFor(() => harness.events.length === 1, 'final message was not emitted on Stop')
    harness.tailer.flushTerminal()
    harness.tailer.stop()
    await settle()

    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toMatchObject({
      type: 'assistant.message.completed',
      payload: {
        content: [{ type: 'text', text: 'only terminal' }],
        final: true,
      },
    })
  })

  test('ignores user, tool, malformed, and non-text assistant transcript lines', async () => {
    const transcriptPath = await createTempTranscriptPath()
    await writeFile(transcriptPath, '')
    const harness = await createHarness()

    harness.tailer.start(transcriptPath)
    await appendFile(transcriptPath, line(userMessage()))
    await appendFile(transcriptPath, line(toolResult()))
    await appendFile(transcriptPath, '{not-json}\n')
    await appendFile(
      transcriptPath,
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use' }] } })
    )
    harness.tailer.handleHook(stopHook())
    await settle()
    harness.tailer.stop()

    expect(harness.events).toEqual([])
  })
})
