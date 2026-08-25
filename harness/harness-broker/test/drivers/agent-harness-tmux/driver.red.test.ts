import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentHarnessControlAck,
  AgentHarnessControlFrame,
  AgentHarnessControlRequest,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import type { Driver, DriverContext } from '../../../src/drivers/driver'

// T-07567 acceptance context: these tests pin the D1/D2 broker-driver boundary.
// The child fake deliberately emits at the acknowledgement boundary so a driver
// that depends on model latency instead of an outbound gate cannot pass.

type TmuxExecCall = {
  argv: string[]
  env?: Record<string, string | undefined> | undefined
  loadedText?: string | undefined
}

type ControlFrameHandler = (frame: AgentHarnessControlFrame) => Promise<void>

type ControlListenerHandle = {
  socketPath: string
  request(frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck>
  close(): Promise<void>
}

type AgentHarnessTmuxDriverFactory = (options: {
  tmux: {
    tmuxBin?: string | undefined
    exec: (
      argv: string[],
      options?: { env?: Record<string, string | undefined> | undefined }
    ) => Promise<{ stdout: string; stderr: string }>
  }
  control: {
    listen(
      handler: ControlFrameHandler,
      context: { invocationId: string; runtimeId?: string | undefined }
    ): Promise<ControlListenerHandle>
  }
  now: () => Date
}) => Driver

type LaunchArtifact = {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined> | undefined
}

const invocationId = 'inv_agent_harness_tmux_red'
const controlSocket = '/tmp/harness-broker/agent-harness-control.red.sock'
const now = () => new Date('2026-08-25T20:45:00.000Z')
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

const paneLease = () => ({
  kind: 'tmux-pane' as const,
  ownership: 'hrc' as const,
  socketPath: '/tmp/harness-broker/agent-harness-tmux.sock',
  sessionId: '$11',
  windowId: '@7',
  paneId: '%51',
  sessionName: 'hrc-owned-agent-harness',
  windowName: 'main',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true, capture: true },
})

const agentHarnessTmuxSpec = (): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'agent-harness', provider: 'openai', driver: 'agent-harness-tmux' },
  process: {
    command: '/opt/bin/agent-harness',
    // The driver owns the socket argv. These stale/semantic values prove it does
    // not forward a second authority channel from the supplied process args.
    args: [
      'tui',
      '--broker-control-socket',
      '/tmp/stale-control.sock',
      '--agent-id',
      'argv-must-not-win',
      '--permission-mode',
      'allow',
    ],
    cwd: '/workspace/agent-spaces',
    lockedEnv: {
      PI_CODING_AGENT_DIR: '/tmp/must-not-determine-auth-path',
      BROKER_ONLY_SENTINEL: 'credential-material-must-not-cross-control-wire',
    },
    harnessTransport: { kind: 'pty' },
  },
  interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: {
    kind: 'agent-harness-tmux',
    terminalHost: 'tmux',
    permissionPolicy: { mode: 'ask-client', timeoutMs: 4321, defaultDecision: 'deny' },
  },
  sdk: {
    runtime: 'pi-sdk',
    provider: 'openai',
    modelId: 'gpt-5.6-test',
    authMode: 'api-key',
    thinkingLevel: 'high',
  },
  agent: {
    agentId: 'smokey',
    projectId: 'agent-spaces',
    agentRoot: '/agents/smokey',
    projectRoot: '/workspace/agent-spaces',
    aspHome: '/workspace/agent-spaces/.asp',
    runMode: 'task',
    scopeRef: 'agent:smokey:project:agent-spaces:task:T-07567',
    laneRef: 'harnessfix',
    runId: 'run-red-07567',
    hostSessionId: 'host-agent-harness-red',
    generation: 4,
  },
  continuation: { provider: 'openai', kind: 'session', key: 'session-red-07567' },
  correlation: {
    hostSessionId: 'host-agent-harness-red',
    runtimeId: 'runtime-agent-harness-red',
  },
})

const userInput = (): InvocationInput => ({
  inputId: 'input_agent_harness_red_1',
  kind: 'user',
  content: [{ type: 'text', text: 'prove the turn handshake' }],
})

function createRecordingExec(calls: TmuxExecCall[]) {
  let pendingLine = ''
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    const call: TmuxExecCall = { argv, env: options?.env }
    calls.push(call)
    if (argv.includes('display-message')) {
      return { stdout: '$11\t@7\t%51\n', stderr: '' }
    }
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

function createCtx(events: InvocationEventEnvelope[]): DriverContext {
  const emitEvent = (event: InvocationEvent, extra?: Record<string, unknown>) => {
    const envelope = {
      invocationId,
      seq: events.length + 1,
      time: now().toISOString(),
      type: event.type,
      payload: event.payload,
      ...extra,
    } as InvocationEventEnvelope
    events.push(envelope)
    return envelope
  }
  return {
    invocationId,
    clientCapabilities: {},
    runtime: { terminalSurface: paneLease() },
    dispatchEnv: { ASP_PROJECT: 'agent-spaces' },
    emit(type, payload, extra) {
      return emitEvent({ type, payload } as InvocationEvent, extra) as never
    },
    emitEvent(event, extra) {
      return emitEvent(event, extra)
    },
  }
}

function createControlFake(
  onRequest: (frame: AgentHarnessControlRequest) => Promise<AgentHarnessControlAck> = async () => ({
    ack: true,
  })
) {
  let handler: ControlFrameHandler | undefined
  const requests: AgentHarnessControlRequest[] = []
  return {
    requests,
    listen: async (nextHandler: ControlFrameHandler): Promise<ControlListenerHandle> => {
      handler = nextHandler
      return {
        socketPath: controlSocket,
        request: async (frame) => {
          requests.push(frame)
          return await onRequest(frame)
        },
        close: async () => undefined,
      }
    },
    receive: async (frame: AgentHarnessControlFrame): Promise<void> => {
      expect(handler).toBeDefined()
      await handler?.(frame)
    },
  }
}

/**
 * The first red runs before the production module exists. A behaviorless
 * fallback keeps every case as a collected assertion failure instead of an
 * import/load error; it is bypassed automatically as soon as the real factory
 * is exported.
 */
async function loadFactory(): Promise<AgentHarnessTmuxDriverFactory> {
  const modulePath = '../../../src/drivers/' + 'agent-harness-tmux/driver'
  const target = (await import(modulePath).catch(() => ({}))) as {
    createAgentHarnessTmuxDriver?: AgentHarnessTmuxDriverFactory | undefined
  }
  if (target.createAgentHarnessTmuxDriver !== undefined) {
    return target.createAgentHarnessTmuxDriver
  }
  return (options) => ({
    kind: 'agent-harness-tmux',
    version: '0.0.0-red',
    capabilities: () =>
      ({
        input: {
          user: false,
          steer: false,
          appendContext: false,
          localImages: false,
          fileRefs: false,
          queue: true,
        },
        turns: { concurrency: 'single', interrupt: 'process' },
        continuation: { supported: false },
        events: {
          assistantDeltas: true,
          toolCalls: true,
          usage: false,
          diagnostics: true,
        },
        control: {
          stop: true,
          dispose: true,
          attach: false,
          driverAttachExistingSurface: false,
        },
        lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
      }) as InvocationCapabilities,
    async start(_spec, ctx) {
      await options.control.listen(async () => undefined, {
        invocationId: ctx.invocationId,
      })
      return { ok: true }
    },
    async applyInputNow() {
      return {}
    },
    async interrupt() {
      return { accepted: false, effect: 'no_active_turn' }
    },
    async stop() {
      return { accepted: true, state: 'exited' }
    },
    async dispose() {},
  })
}

async function startDriver(
  options: {
    calls?: TmuxExecCall[]
    control?: ReturnType<typeof createControlFake>
    events?: InvocationEventEnvelope[]
  } = {}
) {
  const calls = options.calls ?? []
  const control = options.control ?? createControlFake()
  const events = options.events ?? []
  const createDriver = await loadFactory()
  const driver = createDriver({
    tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(calls) },
    control: { listen: control.listen },
    now,
  })
  await driver.start(agentHarnessTmuxSpec(), createCtx(events))
  return { driver, calls, control, events }
}

function inputWasPasted(calls: TmuxExecCall[]): boolean {
  const text = 'prove the turn handshake'
  return calls.some(
    (call) =>
      call.loadedText === text || (call.argv.includes('send-keys') && call.argv.includes(text))
  )
}

function readLaunchArtifact(calls: TmuxExecCall[]): LaunchArtifact | undefined {
  const command = calls
    .map((call) => call.loadedText)
    .find((text) => text?.includes('--launch-file'))
  const path = command?.match(/--launch-file\s+['"]?([^'"\s]+)['"]?/)?.[1]
  return path === undefined ? undefined : (JSON.parse(readFileSync(path, 'utf8')) as LaunchArtifact)
}

const immediateBodyEvent = (turnId: string): AgentHarnessControlFrame => ({
  verb: 'event',
  payload: {
    invocationId,
    seq: 91,
    time: '2020-01-01T00:00:00.000Z',
    turnId,
    inputId: 'input_agent_harness_red_1',
    type: 'assistant.message.delta',
    payload: { messageId: 'message-red-1', text: 'immediate body' },
  },
})

describe('agent-harness-tmux driver D1/D2 acceptance reds', () => {
  test('awaits turn.begin ack before pasting input and returns the broker-allocated turnId', async () => {
    let acknowledge: ((ack: AgentHarnessControlAck) => void) | undefined
    const ack = new Promise<AgentHarnessControlAck>((resolve) => {
      acknowledge = resolve
    })
    const control = createControlFake(async (frame) =>
      frame.verb === 'turn.begin' ? await ack : { ack: true }
    )
    const { driver, calls } = await startDriver({ control })
    calls.length = 0

    const applying = driver.applyInputNow(userInput())
    await flushMicrotasks()
    const turnBegin = control.requests.find((frame) => frame.verb === 'turn.begin')

    expect(turnBegin).toMatchObject({
      verb: 'turn.begin',
      payload: {
        turnId: `turn_${invocationId}_1`,
        inputId: 'input_agent_harness_red_1',
        structured: false,
      },
    })
    expect(inputWasPasted(calls)).toBe(false)

    acknowledge?.({ ack: true })
    const result = await applying
    expect(inputWasPasted(calls)).toBe(true)
    expect(result).toEqual({ turnId: `turn_${invocationId}_1` })
  })

  test('does not settle a turn when the turn.begin ack is suppressed', async () => {
    const neverAck = new Promise<AgentHarnessControlAck>(() => undefined)
    const control = createControlFake(async (frame) =>
      frame.verb === 'turn.begin' ? await neverAck : { ack: true }
    )
    const { driver } = await startDriver({ control })

    const disposition = await Promise.race([
      driver.applyInputNow(userInput()).then(() => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ])

    expect(control.requests.some((frame) => frame.verb === 'turn.begin')).toBe(true)
    expect(disposition).toBe('pending')
  })

  test('gates an event emitted at ack so the broker ledger opens turn.started first', async () => {
    const control = createControlFake(async (frame) => {
      if (frame.verb === 'turn.begin') {
        queueMicrotask(() => void control.receive(immediateBodyEvent(frame.payload.turnId)))
      }
      return { ack: true }
    })
    const createDriver = await loadFactory()
    const driver = createDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec([]) },
      control: { listen: control.listen },
      now,
    })
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event), now })
    await broker.start(
      { spec: agentHarnessTmuxSpec() },
      { ASP_PROJECT: 'agent-spaces' },
      { terminalSurface: paneLease() }
    )

    await broker.input({ invocationId, input: userInput() })
    await flushMicrotasks()

    const startIndex = events.findIndex((event) => event.type === 'turn.started')
    const bodyIndex = events.findIndex((event) => event.type === 'assistant.message.delta')
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(bodyIndex).toBeGreaterThan(startIndex)
  })

  test('projects session.config from the spec after hello without credential material', async () => {
    const { control } = await startDriver()
    await control.receive({
      verb: 'hello',
      payload: { protocolVersion: 'agent-harness-control/v1' },
    })

    const frame = control.requests.find((request) => request.verb === 'session.config')
    expect(frame).toMatchObject({
      verb: 'session.config',
      payload: {
        permissionPolicy: { mode: 'ask-client', timeoutMs: 4321, defaultDecision: 'deny' },
        auth: {
          authMode: 'api-key',
          authPath: join(tmpdir(), 'harness-broker-pi-sdk', invocationId, 'auth.json'),
          providerId: 'openai',
          credentialType: 'api-key',
          storeBound: false,
        },
        sdk: { modelId: 'gpt-5.6-test', thinkingLevel: 'high' },
        agent: agentHarnessTmuxSpec().agent,
        continuation: { key: 'session-red-07567' },
      },
    })
    expect(JSON.stringify(frame)).not.toContain('credential-material-must-not-cross-control-wire')
    expect(JSON.stringify(frame)).not.toContain('BROKER_ONLY_SENTINEL')
  })

  test('launches only tui plus the driver-owned control socket and no semantic argv', async () => {
    const { calls } = await startDriver()
    const artifact = readLaunchArtifact(calls)

    expect(artifact).toBeDefined()
    expect(artifact?.argv).toEqual([
      '/opt/bin/agent-harness',
      'tui',
      '--broker-control-socket',
      controlSocket,
    ])
    expect(artifact?.argv).not.toContain('--agent-id')
    expect(artifact?.argv).not.toContain('--permission-mode')
    expect(artifact?.argv).not.toContain('argv-must-not-win')
  })

  test('matches pi-tui-tmux capabilities', async () => {
    const { driver } = await startDriver()

    expect(driver.capabilities()).toMatchObject({
      input: { user: true, steer: false },
      turns: { concurrency: 'single' },
      continuation: { supported: true },
      control: { attach: true, driverAttachExistingSurface: false },
    })
  })

  test('rejects an invalid event frame, but emits a valid frame with broker sequencing', async () => {
    const { control, events } = await startDriver()
    const before = events.length
    const invalid = immediateBodyEvent('turn_invalid') as {
      verb: 'event'
      payload: Record<string, unknown>
    }
    invalid.payload = { ...invalid.payload, seq: 'not-a-sequence-number' }

    await expect(control.receive(invalid as unknown as AgentHarnessControlFrame)).rejects.toThrow()
    expect(events).toHaveLength(before)

    await control.receive(immediateBodyEvent('turn_valid'))
    const emitted = events.at(-1)
    expect(events).toHaveLength(before + 1)
    expect(emitted).toMatchObject({
      invocationId,
      seq: before + 1,
      time: now().toISOString(),
      turnId: 'turn_valid',
      inputId: 'input_agent_harness_red_1',
      type: 'assistant.message.delta',
      payload: { messageId: 'message-red-1', text: 'immediate body' },
    })
    expect(emitted?.seq).not.toBe(91)
  })
})
