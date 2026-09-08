import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createCodexDesktopDriver } from '../../../src/drivers/codex-desktop/driver'
import { createEventLedger } from '../../../src/event-ledger'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempDir(): string {
  const path = join(tmpdir(), `codex-desktop-${crypto.randomUUID()}`)
  mkdirSync(path, { recursive: true })
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function row(payload: Record<string, unknown>, ordinal: number): string {
  return `${JSON.stringify({ timestamp: new Date(ordinal * 1000).toISOString(), ordinal, type: 'event_msg', payload })}\n`
}

function itemRow(
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  ordinal: number
): string {
  return row({ type: 'item_completed', thread_id: threadId, turn_id: turnId, item }, ordinal)
}

function spec(
  path: string,
  invocationId: string,
  threadId = 'thread-desktop'
): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: invocationId as InvocationId,
    harness: { frontend: 'codex-desktop', provider: 'openai', driver: 'codex-desktop' },
    process: {
      command: 'external-codex-desktop',
      args: [],
      cwd: dirname(path),
      lockedEnv: {},
      harnessTransport: { kind: 'pipes' },
    },
    interaction: { mode: 'service', turnConcurrency: 'single', inputQueue: 'fifo' },
    continuation: { provider: 'openai', key: threadId, kind: 'thread' },
    driver: {
      kind: 'codex-desktop',
      bundleExecutable: '/Applications/ChatGPT.app/Contents/Resources/codex',
      codexHome: '/tmp/codex-home',
      sqliteHome: '/tmp/codex-home',
      threadId,
      rolloutPath: path,
      adoptionWatermark: { byteOffset: 0 },
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for observer')
    await Bun.sleep(10)
  }
}

describe('codex-desktop observation driver', () => {
  test('normalizes native turn, attribution, assistant phases, tools, usage and terminal once', async () => {
    const dir = tempDir()
    const path = join(dir, 'rollout.jsonl')
    const threadId = 'thread-desktop'
    const turnId = 'turn-1'
    writeFileSync(
      path,
      [
        row({ type: 'task_started', turn_id: turnId }, 1),
        itemRow(
          threadId,
          turnId,
          {
            type: 'UserMessage',
            id: 'user-1',
            client_id: 'human-client',
            content: [{ type: 'text', text: 'hello' }],
          },
          2
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'AgentMessage',
            id: 'assistant-commentary',
            phase: 'commentary',
            content: [{ type: 'text', text: 'working' }],
          },
          3
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'CommandExecution',
            id: 'tool-1',
            command: ['echo', 'ok'],
            status: 'completed',
            stdout: 'ok\n',
            stderr: '',
            exit_code: 0,
          },
          4
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'AgentMessage',
            id: 'assistant-final',
            phase: 'final_answer',
            content: [{ type: 'text', text: 'done' }],
          },
          5
        ),
        `${JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', id: 'assistant-final' } })}\n`,
        row({ type: 'token_count', info: { last_token_usage: { total_tokens: 12 } } }, 6),
        row({ type: 'task_complete', turn_id: turnId, last_agent_message: 'done' }, 7),
      ].join('')
    )

    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-basic') })
    await waitFor(() => events.some((event) => event.type === 'turn.completed'))

    const observed = events.filter((event) => event.driver?.kind === 'codex-desktop')
    expect(observed.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(observed.find((event) => event.type === 'turn.attributed')?.payload).toMatchObject({
      ownership: 'foreign',
      origin: 'human',
    })
    expect(observed.filter((event) => event.type === 'assistant.message.completed')).toHaveLength(2)
    expect(
      observed
        .filter((event) => event.type === 'assistant.message.completed')
        .map((event) => event.payload.final)
    ).toEqual([false, true])
    expect(observed.filter((event) => event.type === 'tool.call.completed')).toHaveLength(1)
    expect(observed.filter((event) => event.type === 'tool.call.started')).toHaveLength(0)
    expect(observed.filter((event) => event.type === 'usage.updated')).toHaveLength(1)
    expect(observed.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(observed.every((event) => event.provenance.rawRecordId !== undefined)).toBe(true)
  })

  test('stays ready-degraded until a delayed rollout materializes and preserves partial lines', async () => {
    const dir = tempDir()
    const path = join(dir, 'delayed.jsonl')
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-delayed') })
    expect(
      (
        await broker.status({
          invocationId: 'inv-desktop-delayed' as InvocationId,
          probeLiveness: true,
        })
      ).liveness?.driver
    ).toMatchObject({
      state: 'degraded',
    })

    const started = row({ type: 'task_started', turn_id: 'turn-delayed' }, 1)
    writeFileSync(path, started.slice(0, -1))
    await Bun.sleep(40)
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(0)
    appendFileSync(path, '\n')
    await waitFor(() => events.some((event) => event.type === 'turn.started'))
    expect(
      (
        await broker.status({
          invocationId: 'inv-desktop-delayed' as InvocationId,
          probeLiveness: true,
        })
      ).liveness?.driver
    ).toEqual({
      state: 'healthy',
    })
  })

  test('replacement and observer restart retain native dedupe and append only new history', async () => {
    const dir = tempDir()
    const path = join(dir, 'restart.jsonl')
    const turn1 =
      row({ type: 'task_started', turn_id: 'turn-1' }, 1) +
      row({ type: 'task_complete', turn_id: 'turn-1' }, 2)
    writeFileSync(path, turn1)
    const ledgerPath = join(dir, 'events.ndjson')
    const firstLedger = createEventLedger({ path: ledgerPath })
    const firstEvents: InvocationEventEnvelope[] = []
    const first = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => firstEvents.push(event),
      eventLedger: firstLedger,
      captureDir: dir,
    })
    await first.start({ spec: spec(path, 'inv-desktop-restart') })
    await waitFor(() => firstEvents.some((event) => event.type === 'turn.completed'))
    await first.stop({
      invocationId: 'inv-desktop-restart' as InvocationId,
      reason: 'observer restart',
    })
    firstLedger.close()

    // Same native history plus a new turn: replay must not remint turn-1.
    const turn2 =
      row({ type: 'task_started', turn_id: 'turn-2' }, 3) +
      row({ type: 'task_complete', turn_id: 'turn-2' }, 4)
    writeFileSync(path, turn1 + turn2)
    const secondLedger = createEventLedger({ path: ledgerPath })
    const secondEvents: InvocationEventEnvelope[] = []
    const second = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => secondEvents.push(event),
      eventLedger: secondLedger,
      captureDir: dir,
    })
    await second.start({ spec: spec(path, 'inv-desktop-restart') })
    await waitFor(() =>
      secondEvents.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-2' as never)
      )
    )
    expect(
      secondEvents.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-1' as never)
      )
    ).toHaveLength(0)
    expect(
      secondEvents.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-2' as never)
      )
    ).toHaveLength(1)
    secondLedger.close()
  })

  test('detects a same-path replacement and observes the replacement epoch once', async () => {
    const dir = tempDir()
    const path = join(dir, 'replacement.jsonl')
    const original = [
      row({ type: 'task_started', turn_id: 'turn-original' }, 1),
      row({ type: 'task_complete', turn_id: 'turn-original' }, 2),
    ].join('')
    writeFileSync(path, original)
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-replacement') })
    await waitFor(() =>
      events.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-original' as never)
      )
    )

    const replacementPrefix = `${' '.repeat(original.length - 1)}\n`
    writeFileSync(
      path,
      [
        replacementPrefix,
        row({ type: 'task_started', turn_id: 'turn-replacement' }, 3),
        row({ type: 'task_complete', turn_id: 'turn-replacement' }, 4),
      ].join('')
    )
    await waitFor(() =>
      events.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-replacement' as never)
      )
    )
    expect(
      events.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-original' as never)
      )
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-replacement' as never)
      )
    ).toHaveLength(1)
  })
})
