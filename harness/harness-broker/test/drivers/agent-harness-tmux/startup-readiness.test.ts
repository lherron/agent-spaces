import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentHarnessControlAck,
  AgentHarnessControlFrame,
  AgentHarnessControlRequest,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import {
  type AgentHarnessControlListenerContext,
  listenForAgentHarnessControl,
} from '../../../src/drivers/agent-harness-tmux/control-listener'
import { createAgentHarnessTmuxDriver } from '../../../src/drivers/agent-harness-tmux/driver'

type TmuxExecCall = { argv: string[]; loadedText?: string | undefined }

const invocationId = 'inv_agent_harness_startup_ready'
const controlSocket = '/tmp/harness-broker/agent-harness-control.startup-ready.sock'
const now = () => new Date('2026-08-31T15:30:00.000Z')
const repoRoot = new URL('../../../../../', import.meta.url).pathname
const delayedChildFixture = new URL(
  '../../fixtures/agent-harness-delayed-control-child.ts',
  import.meta.url
).pathname

const paneLease = () => ({
  kind: 'tmux-pane' as const,
  ownership: 'hrc' as const,
  socketPath: '/tmp/harness-broker/agent-harness-tmux-startup-ready.sock',
  sessionId: '$21',
  windowId: '@22',
  paneId: '%23',
  sessionName: 'hrc-owned-agent-harness-startup-ready',
  windowName: 'main',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true, capture: true },
})

function spec(startupTimeoutMs = 1_000): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'agent-harness', provider: 'openai', driver: 'agent-harness-tmux' },
    process: {
      command: '/opt/bin/agent-harness',
      args: [],
      cwd: '/workspace/agent-spaces',
      lockedEnv: {},
      harnessTransport: { kind: 'pty' },
      limits: { startupTimeoutMs, turnTimeoutMs: 1_000, stopGraceMs: 25 },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: {
      kind: 'agent-harness-tmux',
      terminalHost: 'tmux',
      permissionPolicy: { mode: 'allow' },
    },
    sdk: {
      runtime: 'pi-sdk',
      provider: 'openai',
      modelId: 'gpt-5.6-test',
      authMode: 'api-key',
    },
    agent: { agentId: 'cody', projectId: 'agent-spaces' },
    correlation: { runtimeId: 'runtime-agent-harness-startup-ready' },
  } as HarnessInvocationSpec
}

const initialInput: InvocationInput = {
  inputId: 'input_agent_harness_startup_ready',
  kind: 'user',
  content: [{ type: 'text', text: 'FIRST_TURN_MUST_WAIT_FOR_READY' }],
}

function createRecordingExec(calls: TmuxExecCall[]) {
  let pendingLine = ''
  return async (argv: string[]): Promise<{ stdout: string; stderr: string }> => {
    const call: TmuxExecCall = { argv }
    calls.push(call)
    if (argv.includes('display-message')) return { stdout: '$21\t@22\t%23\n', stderr: '' }
    if (argv.includes('load-buffer')) {
      pendingLine = readFileSync(argv.at(-1) ?? '', 'utf8')
      call.loadedText = pendingLine
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('send-keys') && argv.includes('Enter')) {
      pendingLine = ''
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('capture-pane')) return { stdout: pendingLine, stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

function createDelayedControl() {
  let handler: ((frame: AgentHarnessControlFrame) => Promise<void>) | undefined
  let onDisconnect: (() => void) | undefined
  let closeCount = 0
  const requests: AgentHarnessControlRequest[] = []

  return {
    requests,
    get listening() {
      return handler !== undefined
    },
    get closeCount() {
      return closeCount
    },
    listen: async (
      nextHandler: (frame: AgentHarnessControlFrame) => Promise<void>,
      context: AgentHarnessControlListenerContext
    ) => {
      handler = nextHandler
      onDisconnect = context.onDisconnect
      return {
        socketPath: controlSocket,
        request: async (frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck> => {
          requests.push(frame)
          return { ack: true }
        },
        close: async () => {
          closeCount += 1
        },
      }
    },
    async hello(): Promise<void> {
      await handler?.({ verb: 'hello', payload: { protocolVersion: 'agent-harness-control/v1' } })
    },
    async ready(): Promise<void> {
      await handler?.({
        verb: 'ready',
        payload: { sessionFile: '/sessions/startup-ready.jsonl' },
      })
    },
    disconnect(): void {
      onDisconnect?.()
    },
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error('condition did not become true')
}

function createSubject(startupTimeoutMs = 1_000) {
  const calls: TmuxExecCall[] = []
  const events: InvocationEventEnvelope[] = []
  const control = createDelayedControl()
  const driver = createAgentHarnessTmuxDriver({
    tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(calls) },
    control: { listen: control.listen },
    now,
  })
  const broker = createBroker({
    drivers: [driver],
    onEvent: (event: InvocationEventEnvelope) => events.push(event),
    now,
  })
  return { broker, calls, control, driver, events, invocationSpec: spec(startupTimeoutMs) }
}

describe('agent-harness-tmux startup readiness', () => {
  test('holds initialInput across a real socket until a delayed child process is ready', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-harness-startup-ready-'))
    const socketPath = join(tempDir, 'control.sock')
    const events: InvocationEventEnvelope[] = []
    let pendingLine = ''
    let child: ReturnType<typeof Bun.spawn> | undefined
    const driver = createAgentHarnessTmuxDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: async (argv) => {
          if (argv.includes('display-message')) return { stdout: '$21\t@22\t%23\n', stderr: '' }
          if (argv.includes('load-buffer')) {
            pendingLine = readFileSync(argv.at(-1) ?? '', 'utf8')
            return { stdout: '', stderr: '' }
          }
          if (argv.includes('send-keys') && argv.includes('Enter')) {
            if (child === undefined && pendingLine.includes('tmux-launch-runner')) {
              child = Bun.spawn({
                cmd: [process.execPath, delayedChildFixture, socketPath, '75'],
                cwd: repoRoot,
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'pipe',
              })
            }
            pendingLine = ''
            return { stdout: '', stderr: '' }
          }
          if (argv.includes('capture-pane')) return { stdout: pendingLine, stderr: '' }
          return { stdout: '', stderr: '' }
        },
      },
      control: {
        listen: (handler, context) =>
          listenForAgentHarnessControl(socketPath, handler, context.onDisconnect),
      },
      now,
    })
    const broker = createBroker({
      drivers: [driver],
      onEvent: (event: InvocationEventEnvelope) => events.push(event),
      now,
    })
    const startedAt = performance.now()

    try {
      await broker.start({ spec: spec(2_000), initialInput }, {}, { terminalSurface: paneLease() })

      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(50)
      expect(events.map((event) => event.type)).toContain('continuation.updated')
      expect(events.map((event) => event.type)).toContain('input.accepted')
      expect(events.map((event) => event.type)).toContain('turn.started')
      expect(child).toBeDefined()
    } finally {
      await driver.dispose()
      if (child !== undefined) {
        const exitCode = await child.exited
        const stderr = await new Response(child.stderr).text()
        expect(exitCode).toBe(0)
        expect(stderr).toBe('')
      }
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps start and initialInput pending until hello -> session.config -> ready', async () => {
    const { broker, control, events, invocationSpec } = createSubject()
    const starting = broker.start(
      { spec: invocationSpec, initialInput },
      {},
      {
        terminalSurface: paneLease(),
      }
    )

    await waitUntil(() => control.listening)
    await Bun.sleep(5)
    expect(control.requests.some((frame) => frame.verb === 'turn.begin')).toBe(false)

    await control.hello()
    expect(control.requests.some((frame) => frame.verb === 'session.config')).toBe(true)
    expect(control.requests.some((frame) => frame.verb === 'turn.begin')).toBe(false)

    const beforeReady = await Promise.race([
      starting.then(() => 'settled' as const),
      Bun.sleep(20).then(() => 'pending' as const),
    ])
    expect(beforeReady).toBe('pending')

    await control.ready()
    await starting

    expect(control.requests.map((frame) => frame.verb)).toEqual(['session.config', 'turn.begin'])
    expect(events.map((event) => event.type)).toContain('input.accepted')
    expect(events.map((event) => event.type)).toContain('turn.started')
  })

  test('times out once and tears down the control listener and leased pane', async () => {
    const { broker, calls, control, driver, events, invocationSpec } = createSubject(20)

    await expect(
      broker.start({ spec: invocationSpec }, {}, { terminalSurface: paneLease() })
    ).rejects.toMatchObject({ code: BrokerErrorCode.Timeout })

    expect(control.closeCount).toBe(1)
    expect(
      calls.filter((call) => call.argv.includes('send-keys') && call.argv.includes('C-c'))
    ).toHaveLength(1)
    expect(events.filter((event) => event.type === 'invocation.failed')).toHaveLength(1)
    await expect(
      driver.interrupt({ invocationId, reason: 'prove lease cleared' })
    ).resolves.toMatchObject({ accepted: false, effect: 'no_active_turn' })
  })

  test('disconnect before ready fails once and performs the same teardown', async () => {
    const { broker, calls, control, events, invocationSpec } = createSubject()
    const starting = broker.start({ spec: invocationSpec }, {}, { terminalSurface: paneLease() })

    await waitUntil(() => control.listening)
    await control.hello()
    const startOutcome = starting.then(
      () => undefined,
      (error: unknown) => error
    )
    control.disconnect()

    const startError = await startOutcome
    expect(startError).toBeInstanceOf(Error)
    expect((startError as Error).message).toMatch(/disconnected before ready/)
    expect(control.closeCount).toBe(1)
    expect(
      calls.filter((call) => call.argv.includes('send-keys') && call.argv.includes('C-c'))
    ).toHaveLength(1)
    expect(events.filter((event) => event.type === 'invocation.failed')).toHaveLength(1)
    expect(events.some((event) => event.type === 'invocation.exited')).toBe(false)
  })
})
