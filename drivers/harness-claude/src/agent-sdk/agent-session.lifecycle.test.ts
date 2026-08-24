import { describe, expect, test } from 'bun:test'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import { AgentSession } from './agent-session.js'

type Queued = { kind: 'value'; value: unknown } | { kind: 'done' } | { kind: 'error'; error: Error }

class ManualQuery implements AsyncIterator<unknown> {
  interruptCount = 0
  returnCount = 0
  private queue: Queued[] = []
  private waiters: Array<(queued: Queued) => void> = []
  readonly [Symbol.asyncIterator] = (): AsyncIterator<unknown> => this

  async next(): Promise<IteratorResult<unknown>> {
    const queued =
      this.queue.shift() ?? (await new Promise<Queued>((resolve) => this.waiters.push(resolve)))
    if (queued.kind === 'value') return { value: queued.value, done: false }
    if (queued.kind === 'error') throw queued.error
    return { value: undefined, done: true }
  }

  async return(): Promise<IteratorResult<unknown>> {
    this.returnCount += 1
    this.pushDone()
    return { value: undefined, done: true }
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1
  }

  push(value: unknown): void {
    this.deliver({ kind: 'value', value })
  }

  pushDone(): void {
    this.deliver({ kind: 'done' })
  }

  pushError(error: Error): void {
    this.deliver({ kind: 'error', error })
  }

  private deliver(queued: Queued): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(queued)
      return
    }
    this.queue.push(queued)
  }
}

function makeSession() {
  const query = new ManualQuery()
  const session = new AgentSession(
    {
      ownerId: 'owner-lifecycle',
      cwd: '/tmp',
      model: 'sonnet',
      sessionId: 'agent-session-lifecycle',
      continuationKey: 'resume-key',
    },
    undefined,
    {
      queryFactory: (() => query as unknown as Query) as never,
      runtimeEnv: { pid: 4242, env: { PATH: '/usr/bin' } },
    }
  )
  const events: UnifiedSessionEvent[] = []
  session.onEvent((event) => events.push(event))
  return { session, query, events }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function eventTypes(events: UnifiedSessionEvent[]): string[] {
  return events.map((event) => event.type)
}

function countType(events: UnifiedSessionEvent[], type: UnifiedSessionEvent['type']): number {
  return events.filter((event) => event.type === type).length
}

function pushInit(query: ManualQuery, sdkSessionId = 'sdk-lifecycle'): void {
  query.push({ type: 'system', subtype: 'init', session_id: sdkSessionId, plugins: [] })
}

describe('AgentSession lifecycle event stream characterization (T-04632)', () => {
  test('normal result emits one agent_start, one agent_end, turn_end, and metadata', async () => {
    const { session, query, events } = makeSession()

    await session.start()
    await session.sendPrompt('hello')
    pushInit(query)
    query.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello back' }] },
    })
    query.push({ type: 'result', subtype: 'success' })

    await waitFor(() => eventTypes(events).includes('turn_end'), 'normal turn_end')

    expect(session.getState()).toBe('running')
    expect(session.getMetadata()).toMatchObject({
      sessionId: 'agent-session-lifecycle',
      kind: 'agent-sdk',
      state: 'running',
      nativeIdentity: 'sdk-lifecycle',
      continuationKey: 'resume-key',
      pid: 4242,
      capabilities: {
        supportsInterrupt: true,
        supportsInFlightInput: false,
        supportsNativeResume: true,
        supportsAttach: false,
      },
    })

    await session.stop('complete')

    expect(countType(events, 'agent_start')).toBe(1)
    expect(countType(events, 'turn_end')).toBe(1)
    expect(countType(events, 'agent_end')).toBe(1)
    expect(eventTypes(events)).toEqual([
      'turn_start',
      'sdk_session_id',
      'agent_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ])
    expect(events.findLast((event) => event.type === 'agent_end')).toMatchObject({
      type: 'agent_end',
      reason: 'complete',
      sdkSessionId: 'sdk-lifecycle',
    })
    expect(session.getState()).toBe('stopped')
    expect(query.interruptCount).toBe(1)
  })

  test('explicit stop flushes pending turn_end before agent_end and does not double-end', async () => {
    const { session, query, events } = makeSession()

    await session.start()
    await session.sendPrompt('stop me')
    pushInit(query, 'sdk-stop')
    await waitFor(() => eventTypes(events).includes('agent_start'), 'agent_start before stop')

    await session.stop('user-stop')

    expect(countType(events, 'agent_start')).toBe(1)
    expect(countType(events, 'turn_end')).toBe(1)
    expect(countType(events, 'agent_end')).toBe(1)
    expect(eventTypes(events).slice(-2)).toEqual(['turn_end', 'agent_end'])
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'user-stop' })
    expect(session.getState()).toBe('stopped')
  })

  test('iterator error wins state=error and still flushes turn_end before agent_end', async () => {
    const { session, query, events } = makeSession()

    await session.start()
    await session.sendPrompt('error please')
    pushInit(query, 'sdk-error')
    await waitFor(() => eventTypes(events).includes('agent_start'), 'agent_start before error')
    query.pushError(new Error('sdk iterator failed'))

    await waitFor(() => session.getState() === 'error', 'error state')

    expect(countType(events, 'agent_start')).toBe(1)
    expect(countType(events, 'turn_end')).toBe(1)
    expect(countType(events, 'agent_end')).toBe(1)
    expect(eventTypes(events).slice(-2)).toEqual(['turn_end', 'agent_end'])
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' })
    expect(session.getMetadata().state).toBe('error')
  })

  test('iterator clean exit without a result flushes pending turn_end before stopped agent_end', async () => {
    const { session, query, events } = makeSession()

    await session.start()
    await session.sendPrompt('iterator exits')
    pushInit(query, 'sdk-crash-exit')
    await waitFor(() => eventTypes(events).includes('agent_start'), 'agent_start before clean exit')
    query.pushDone()

    await waitFor(() => session.getState() === 'stopped', 'stopped state after clean iterator exit')

    expect(countType(events, 'agent_start')).toBe(1)
    expect(countType(events, 'turn_end')).toBe(1)
    expect(countType(events, 'agent_end')).toBe(1)
    expect(eventTypes(events).slice(-2)).toEqual(['turn_end', 'agent_end'])
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'stopped' })
    expect(session.getMetadata().state).toBe('stopped')
  })
})
