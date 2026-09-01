import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import type { AgentSessionEvent, AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import type {
  CreateAgentHarnessRuntimeOptions,
  LoadAgentOptions,
  ResolvedAgent,
} from 'agent-harness-runtime'
import type { AgentHarnessSessionConfig } from 'spaces-harness-broker-protocol'
import { encodeAgentHarnessControlFrame } from 'spaces-harness-broker-protocol'

import { type ForegroundTuiDependencies, runAgentHarnessTui } from './tui'

/**
 * T-07710. A prompt the operator types straight into the pane reaches pi with
 * no broker `turn.begin`. The mapper drops every session event while it holds
 * no turn, so before this fix an interactive seat driven by hand produced an
 * EMPTY ledger (sparky gen-6: 11 typed turns, 0 activity events). The TUI must
 * mint its own turn for such runs, carry the typed prompt, and close the turn
 * on settle so the next typed prompt mints a fresh one.
 */

type BrokerTuiRunner = (
  options: LoadAgentOptions & { brokerControlSocket: string },
  dependencies?: ForegroundTuiDependencies
) => Promise<void>

const runBrokerTui = runAgentHarnessTui as BrokerTuiRunner

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const config = {
  permissionPolicy: { mode: 'allow' },
  auth: {
    authMode: 'oauth',
    authPath: '/broker/credentials/auth.json',
    providerId: 'openai-codex',
    credentialType: 'oauth',
    storeBound: true,
  },
  sdk: { modelId: 'gpt-5.6-terra' },
  agent: { agentId: 'sparky', projectId: 'agent-spaces', scopeRef: 'inv-operator-07710' },
} as AgentHarnessSessionConfig

interface ControlRecord {
  socketPath: string
  events: () => Array<Record<string, unknown>>
  sendTurnBegin: (turnId: string, inputId: string) => void
}

/** Broker end: answers `hello` with session.config, records every `event` frame. */
async function startControl(): Promise<ControlRecord> {
  const directory = await mkdtemp('/tmp/ah-op-')
  const socketPath = join(directory, 'control.sock')
  const sockets = new Set<Socket>()
  const events: Array<Record<string, unknown>> = []
  let live: Socket | undefined
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    live = socket
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.length === 0) continue
        const frame = JSON.parse(line) as Record<string, unknown>
        if (frame['verb'] === 'hello') {
          socket.write(
            encodeAgentHarnessControlFrame({
              verb: 'session.config',
              requestId: 'req-operator-1',
              payload: config,
            })
          )
        } else if (frame['verb'] === 'event') {
          events.push(frame['payload'] as Record<string, unknown>)
        }
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  return {
    socketPath,
    events: () => events,
    sendTurnBegin(turnId, inputId) {
      live?.write(
        encodeAgentHarnessControlFrame({
          verb: 'turn.begin',
          requestId: `req-turn-${turnId}`,
          payload: { turnId, inputId, structured: false },
        })
      )
    },
  }
}

const assistantMessage = (text: string) => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text }],
  api: 'openai-responses',
  provider: 'openai-codex',
  model: 'gpt-5.6-terra',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
  stopReason: 'stop' as const,
  timestamp: 1,
})

/** One model round inside a Pi agent run. */
function agentRound(prompt: string, reply: string): AgentSessionEvent[] {
  return [
    { type: 'message_start', message: { role: 'user', content: prompt, timestamp: 0 } },
    { type: 'message_end', message: { role: 'user', content: prompt, timestamp: 0 } },
    { type: 'turn_start' },
    { type: 'message_start', message: assistantMessage('') },
    {
      type: 'message_update',
      message: assistantMessage(reply),
      assistantMessageEvent: { type: 'text_delta', delta: reply },
    },
    { type: 'message_end', message: assistantMessage(reply) },
    { type: 'turn_end', message: assistantMessage(reply), toolResults: [] },
  ] as unknown as AgentSessionEvent[]
}

/** One complete Pi agent run for a typed prompt, as Pi 0.84.4 emits it. */
function operatorRun(prompt: string, reply: string): AgentSessionEvent[] {
  return [
    { type: 'agent_start' },
    ...agentRound(prompt, reply),
    { type: 'agent_end', messages: [] },
    { type: 'agent_settled' },
  ] as unknown as AgentSessionEvent[]
}

function harness(
  run: (emit: (event: AgentSessionEvent) => void, control: ControlRecord) => Promise<void>,
  control: ControlRecord
): ForegroundTuiDependencies {
  let listener: ((event: AgentSessionEvent) => void) | undefined
  const runtime = {
    session: {
      sessionFile: '/tmp/agent-harness-session-07710.jsonl',
      subscribe(fn: (event: AgentSessionEvent) => void) {
        listener = fn
        return () => undefined
      },
    },
    async dispose() {},
  } as unknown as AgentSessionRuntime
  return {
    async loadAgent() {
      return {
        agentId: 'sparky',
        aspHome: '/tmp/asp-home',
        placement: { agentRoot: '/tmp/agents/sparky', cwd: '/tmp/project', runMode: 'task' },
        model: { piProvider: 'openai-codex', piModelId: 'gpt-5.6-terra', authMode: 'oauth' },
        environment: {},
        sources: { effectiveConfig: {} },
        skillPaths: [],
        warnings: [],
      } as unknown as ResolvedAgent
    },
    async createRuntime(_options: CreateAgentHarnessRuntimeOptions) {
      return runtime
    },
    async runInteractiveMode() {
      if (listener === undefined) throw new Error('session not subscribed')
      await run(listener, control)
      // let the socket drain before the finally closes it
      await new Promise((resolve) => setTimeout(resolve, 20))
    },
  }
}

const types = (events: Array<Record<string, unknown>>): string[] =>
  events.map((event) => String(event['type']))

describe('agent-harness broker TUI operator-typed turns (T-07710)', () => {
  test('mints a turn for a typed prompt and carries the full bracket to the broker', async () => {
    const control = await startControl()
    await runBrokerTui(
      { agentId: 'sparky', brokerControlSocket: control.socketPath },
      harness(async (emit) => {
        for (const event of operatorRun('find the pi theme config', 'It is in theme.json')) {
          emit(event)
        }
      }, control)
    )

    const events = control.events()
    expect(types(events)).toEqual([
      'turn.started',
      'user.message',
      'assistant.message.started',
      'assistant.message.delta',
      'usage.updated',
      'assistant.message.completed',
      'turn.completed',
      'continuation.updated',
    ])
    const started = events[0] as { turnId: string; payload: { source: string; turnId: string } }
    expect(started.payload.source).toBe('hook-observed')
    expect(started.turnId).toMatch(/^turn_inv-operator-07710_tui_1$/)
    expect(started.payload.turnId).toBe(started.turnId)
    expect((events[1] as { payload: { content: string } }).payload.content).toBe(
      'find the pi theme config'
    )
    for (const event of events.filter((e) => e['type'] !== 'continuation.updated')) {
      expect(event['turnId']).toBe(started.turnId)
    }
  })

  test('a second typed prompt after settle mints a fresh turn id', async () => {
    const control = await startControl()
    await runBrokerTui(
      { agentId: 'sparky', brokerControlSocket: control.socketPath },
      harness(async (emit) => {
        for (const event of operatorRun('one', 'a')) emit(event)
        for (const event of operatorRun('two', 'b')) emit(event)
      }, control)
    )

    const starts = control.events().filter((event) => event['type'] === 'turn.started')
    expect(starts.map((event) => event['turnId'])).toEqual([
      'turn_inv-operator-07710_tui_1',
      'turn_inv-operator-07710_tui_2',
    ])
    expect(types(control.events()).filter((type) => type === 'turn.completed')).toHaveLength(2)
  })

  test('busy follow-up prompts stay in one Pi run until agent_settled', async () => {
    const control = await startControl()
    await runBrokerTui(
      { agentId: 'sparky', brokerControlSocket: control.socketPath },
      harness(async (emit) => {
        // Pi 0.84.4 drains prompts submitted while busy inside the same agent
        // run. It emits one agent_start/agent_settled bracket around every
        // queued user message and model round; agent_end is not a safe broker
        // terminal because retry/compaction/follow-up work may still continue.
        const busyRun = [
          { type: 'agent_start' },
          ...agentRound('one', 'a'),
          ...agentRound('two while busy', 'b'),
          { type: 'agent_end', messages: [] },
          { type: 'agent_settled' },
        ] as unknown as AgentSessionEvent[]
        for (const event of busyRun) emit(event)
        for (const event of operatorRun('three after settle', 'c')) emit(event)
      }, control)
    )

    const events = control.events()
    const starts = events.filter((event) => event['type'] === 'turn.started')
    const completed = events.filter((event) => event['type'] === 'turn.completed')
    const userMessages = events.filter((event) => event['type'] === 'user.message') as Array<{
      turnId: string
      payload: { content: string }
    }>

    expect(starts.map((event) => event['turnId'])).toEqual([
      'turn_inv-operator-07710_tui_1',
      'turn_inv-operator-07710_tui_2',
    ])
    expect(completed.map((event) => event['turnId'])).toEqual([
      'turn_inv-operator-07710_tui_1',
      'turn_inv-operator-07710_tui_2',
    ])
    expect(userMessages.map((event) => [event.turnId, event.payload.content])).toEqual([
      ['turn_inv-operator-07710_tui_1', 'one'],
      ['turn_inv-operator-07710_tui_1', 'two while busy'],
      ['turn_inv-operator-07710_tui_2', 'three after settle'],
    ])
  })

  test('a broker-delivered turn keeps its own id and is not re-minted', async () => {
    const control = await startControl()
    await runBrokerTui(
      { agentId: 'sparky', brokerControlSocket: control.socketPath },
      harness(async (emit, ctl) => {
        ctl.sendTurnBegin('turn_broker_9', 'input-9')
        // wait for the TUI to bind the turn (ack round-trip)
        await new Promise((resolve) => setTimeout(resolve, 50))
        for (const event of operatorRun('delivered', 'ok')) emit(event)
      }, control)
    )

    const events = control.events()
    // No TUI-minted turn.started and no user.message: the broker owns both for
    // a delivered input.
    expect(types(events)).toEqual([
      'assistant.message.started',
      'assistant.message.delta',
      'usage.updated',
      'assistant.message.completed',
      'turn.completed',
      'continuation.updated',
    ])
    for (const event of events.filter((e) => e['type'] !== 'continuation.updated')) {
      expect(event['turnId']).toBe('turn_broker_9')
    }
  })
})
