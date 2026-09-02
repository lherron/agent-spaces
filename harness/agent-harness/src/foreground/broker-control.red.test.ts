import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import type {
  AgentSessionEvent,
  AgentSessionRuntime,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent'
import type {
  CreateAgentHarnessRuntimeOptions,
  LoadAgentOptions,
  ResolvedAgent,
} from 'agent-harness-runtime'
import { resolveAgentHarnessModel } from 'agent-harness-runtime'
import {
  type AgentHarnessControlFrame,
  type AgentHarnessControlSessionConfigFrame,
  type AgentHarnessSessionConfig,
  encodeAgentHarnessControlFrame,
  validateAgentHarnessControlFrame,
} from 'spaces-harness-broker-protocol'

import { type ForegroundTuiDependencies, runAgentHarnessTui } from './tui'

// T-07566 acceptance context: this socket double is the broker authority. These
// tests deliberately make its auth and permission values disagree with values
// the foreground profile could derive, so accidental child-side re-resolution
// cannot satisfy the assertions.

type BrokerTuiOptions = LoadAgentOptions & {
  brokerControlSocket: string
  prompt?: string | undefined
  resume?: string | boolean | undefined
}

type BrokerTuiRunner = (
  options: BrokerTuiOptions,
  dependencies?: ForegroundTuiDependencies
) => Promise<void>

const runBrokerTui = runAgentHarnessTui as BrokerTuiRunner

const CONFIG_REQUEST_ID = 'config-request-07566'
const TURN_REQUEST_ID = 'turn-request-07566'
const BROKER_TURN_ID = 'broker-turn-07566'
const REFUSED_REQUEST_ID = 'turn-request-refused-07584'
const REFUSED_TURN_ID = 'broker-turn-refused-07584'
const RECOVERED_REQUEST_ID = 'turn-request-recovered-07584'
const RECOVERED_TURN_ID = 'broker-turn-recovered-07584'
const INTERRUPT_REQUEST_ID = 'turn-interrupt-07869'
const INTERRUPT_REASON = 'submission.preempt:submission-07869'

const deliveredConfig = {
  permissionPolicy: { mode: 'deny' },
  auth: {
    authMode: 'oauth',
    authPath: '/broker/credentials/auth.json',
    providerId: 'openai-codex',
    credentialType: 'oauth',
    storeBound: true,
  },
  sdk: {
    modelId: 'gpt-5.6-terra',
    thinkingLevel: 'high',
  },
  agent: {
    agentId: 'smokey',
    projectId: 'agent-spaces',
    scopeRef: 'agent:smokey:project:agent-spaces:task:T-07566',
  },
  continuation: { key: 'session-07566.jsonl' },
} as const satisfies AgentHarnessSessionConfig

const controls: BrokerControlDouble[] = []

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.dispose()))
})

describe('agent-harness TUI broker control', () => {
  for (const failure of ['withheld', 'malformed', 'late'] as const) {
    test(`fails closed before constructing anything when session.config is ${failure}`, async () => {
      const control = await BrokerControlDouble.start(failure)
      const construction = constructionSentinels()
      const result = await captureFailure(
        runBrokerTui(
          { agentId: 'smokey', brokerControlSocket: control.socketPath },
          construction.dependencies
        )
      )

      expect(construction.calls).toEqual([])
      expect(result).toBeInstanceOf(Error)
      expect(control.protocolErrors).toEqual([])
      expect(control.frames.map((frame) => frame.verb)).toContain('hello')
    })
  }

  test('narrows the Pi provider namespace before real catalog lookup and never consults foreground auth', async () => {
    const control = await BrokerControlDouble.start('configured')
    const observedForegroundKeys: PropertyKey[] = []
    let loadOptions: LoadAgentOptions | undefined
    let runtimeOptions: CreateAgentHarnessRuntimeOptions | undefined
    const harness = runtimeHarness({
      environment: new Proxy(
        {
          HARNESS_PI_AUTH_STORE: '/foreground/credentials/auth.json',
          PI_CODING_AGENT_DIR: '/foreground/pi-agent',
        },
        {
          get(target, key, receiver) {
            observedForegroundKeys.push(key)
            return Reflect.get(target, key, receiver)
          },
        }
      ),
      onLoad(options) {
        loadOptions = options
      },
      onCreate(options) {
        runtimeOptions = options
      },
    })

    await runBrokerTui(
      { agentId: 'ignored-foreground-id', brokerControlSocket: control.socketPath },
      harness.dependencies
    )

    expect(runtimeOptions?.auth).toEqual({
      authMode: deliveredConfig.auth.authMode,
      authPath: deliveredConfig.auth.authPath,
      providerId: deliveredConfig.auth.providerId,
    })
    expect(runtimeOptions?.authStorePath).toBeUndefined()
    expect(observedForegroundKeys).not.toContain('HARNESS_PI_AUTH_STORE')
    expect(observedForegroundKeys).not.toContain('PI_CODING_AGENT_DIR')
    expect(loadOptions).toMatchObject({
      ...deliveredConfig.agent,
      model: deliveredConfig.sdk.modelId,
      provider: undefined,
      reasoningEffort: deliveredConfig.sdk.thinkingLevel,
    })
    expect(
      resolveAgentHarnessModel(loadOptions?.provider, deliveredConfig.sdk.modelId)
    ).toMatchObject({
      alias: 'openai-codex/gpt-5.6-terra',
      piProvider: 'openai-codex',
    })
  })

  test('retains the anthropic provider namespace through the narrowing', async () => {
    const anthropicConfig = {
      ...deliveredConfig,
      auth: { ...deliveredConfig.auth, providerId: 'anthropic' },
      sdk: { ...deliveredConfig.sdk, modelId: 'claude-sonnet-4-5' },
    } as const satisfies AgentHarnessSessionConfig
    const control = await BrokerControlDouble.start('configured', anthropicConfig)
    let loadOptions: LoadAgentOptions | undefined
    const harness = runtimeHarness({
      onLoad(options) {
        loadOptions = options
      },
    })

    await runBrokerTui(
      { agentId: 'ignored-foreground-id', brokerControlSocket: control.socketPath },
      harness.dependencies
    )

    expect(loadOptions?.provider).toBe('anthropic')
    expect(
      resolveAgentHarnessModel(loadOptions?.provider, anthropicConfig.sdk.modelId)
    ).toMatchObject({
      alias: 'anthropic-max/claude-sonnet-4-5',
      piProvider: 'anthropic',
    })
  })

  test('enforces delivered deny inside the TUI when the loaded profile independently says yolo', async () => {
    const control = await BrokerControlDouble.start('configured')
    let toolCallResult: unknown
    const harness = runtimeHarness({
      profileYolo: true,
      async onInteractive() {
        toolCallResult = await harness.invokeToolCall({
          type: 'tool_call',
          toolCallId: 'tool-07566',
          toolName: 'bash',
          input: { command: 'touch must-not-run' },
        } as ToolCallEvent)
      },
    })

    await runBrokerTui(
      { agentId: 'smokey', brokerControlSocket: control.socketPath },
      harness.dependencies
    )

    expect(toolCallResult).toEqual({
      block: true,
      reason: 'Denied by invocation permission policy',
    })
  })

  test('drops pre-handshake events and maps post-ack events to the broker turn id', async () => {
    const control = await BrokerControlDouble.start('turn-handshake')
    const harness = runtimeHarness({
      async onInteractive() {
        if (!harness.hasSessionSubscriber()) return
        harness.emitSessionEvent(assistantDelta('must-be-dropped'))
        await control.waitForAck(TURN_REQUEST_ID)
        expect(control.frames.filter((frame) => frame.verb === 'event')).toEqual([])

        harness.emitSessionEvent(assistantDelta('after-handshake'))
        await control.waitForFrame('event')
      },
    })

    await runBrokerTui(
      { agentId: 'smokey', brokerControlSocket: control.socketPath },
      harness.dependencies
    )

    const events = control.frames.filter((frame) => frame.verb === 'event')
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((frame) => frame.payload.turnId === BROKER_TURN_ID)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('must-be-dropped')
    expect(JSON.stringify(events)).toContain('after-handshake')
  })

  // T-07584: a turn the mapper cannot bind is answered, not fatal. Before this,
  // the child's only two options on a control request were ACK or DIE, so
  // "I cannot begin this turn" was wire-indistinguishable from "I crashed" and
  // took the whole invocation down for one refused turn.
  test('nacks an unbindable turn.begin, keeps the channel, and binds a later turn on the same runtime', async () => {
    const control = await BrokerControlDouble.start('turn-refusal')
    const harness = runtimeHarness({
      async onInteractive() {
        if (!harness.hasSessionSubscriber()) return
        await control.waitForAck(TURN_REQUEST_ID)

        // A second turn while the first is still live: unbindable by construction.
        control.sendTurnBegin(REFUSED_REQUEST_ID, REFUSED_TURN_ID)
        await control.waitForNack(REFUSED_REQUEST_ID)

        // The channel and the runtime both survived: the LIVE turn keeps mapping.
        harness.emitSessionEvent(assistantDelta('after-refusal'))
        await control.waitForFrame('event')

        // Settle the live turn, then a later turn binds on the SAME runtime.
        harness.emitSessionEvent({ type: 'agent_settled' } as AgentSessionEvent)
        control.sendTurnBegin(RECOVERED_REQUEST_ID, RECOVERED_TURN_ID)
        await control.waitForAck(RECOVERED_REQUEST_ID)
      },
    })

    await runBrokerTui(
      { agentId: 'smokey', brokerControlSocket: control.socketPath },
      harness.dependencies
    )

    expect(control.nacks).toEqual([
      {
        requestId: REFUSED_REQUEST_ID,
        code: 'turn_already_active',
        message: expect.stringContaining(BROKER_TURN_ID) as unknown as string,
      },
    ])
    expect(control.acked(RECOVERED_REQUEST_ID)).toBe(true)
    expect(control.protocolErrors).toEqual([])

    // The refused turn never bound: nothing on the wire carries its turnId.
    const events = control.frames.filter((frame) => frame.verb === 'event')
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain(REFUSED_TURN_ID)
    expect(JSON.stringify(events)).toContain('after-refusal')
  })

  test('acks turn.interrupt only after aborting and terminalizes a wedged turn without agent_settled', async () => {
    const control = await BrokerControlDouble.start('turn-handshake')
    let aborts = 0
    const harness = runtimeHarness({
      onAbort() {
        aborts += 1
      },
      async onInteractive() {
        await control.waitForAck(TURN_REQUEST_ID)
        harness.emitSessionEvent(assistantDelta('partial output before the missing settlement'))

        control.sendTurnInterrupt(INTERRUPT_REQUEST_ID, INTERRUPT_REASON)
        await control.waitForAck(INTERRUPT_REQUEST_ID)

        // Recovery is real: the mapper released the old turn even though no
        // agent_settled event ever arrived, so another broker turn can bind.
        control.sendTurnBegin(RECOVERED_REQUEST_ID, RECOVERED_TURN_ID)
        await control.waitForAck(RECOVERED_REQUEST_ID)
      },
    })

    await runBrokerTui(
      { agentId: 'smokey', brokerControlSocket: control.socketPath },
      harness.dependencies
    )

    expect(aborts).toBe(1)
    expect(control.acked(INTERRUPT_REQUEST_ID)).toBe(true)
    expect(control.acked(RECOVERED_REQUEST_ID)).toBe(true)
    const terminals = control.frames.filter(
      (frame) => frame.verb === 'event' && frame.payload.type.startsWith('turn.')
    )
    expect(terminals).toContainEqual(
      expect.objectContaining({
        verb: 'event',
        payload: expect.objectContaining({
          turnId: BROKER_TURN_ID,
          type: 'turn.interrupted',
          payload: expect.objectContaining({
            status: 'interrupted',
            reason: INTERRUPT_REASON,
          }) as unknown,
        }) as unknown,
      })
    )
    expect(
      terminals.some((frame) => frame.verb === 'event' && frame.payload.type === 'turn.completed')
    ).toBe(false)
    expect(control.protocolErrors).toEqual([])
  })

  test('nacks turn.interrupt when the child has no active turn and does not abort', async () => {
    const control = await BrokerControlDouble.start('configured')
    let aborts = 0
    const harness = runtimeHarness({
      onAbort() {
        aborts += 1
      },
      async onInteractive() {
        control.sendTurnInterrupt(INTERRUPT_REQUEST_ID, INTERRUPT_REASON)
        await control.waitForNack(INTERRUPT_REQUEST_ID)
      },
    })

    await runBrokerTui(
      { agentId: 'smokey', brokerControlSocket: control.socketPath },
      harness.dependencies
    )

    expect(aborts).toBe(0)
    expect(control.nacks).toEqual([
      {
        requestId: INTERRUPT_REQUEST_ID,
        code: 'no_active_turn',
        message: expect.stringContaining('no pi SDK turn is active') as unknown as string,
      },
    ])
    expect(control.frames.some((frame) => frame.verb === 'event')).toBe(false)
    expect(control.protocolErrors).toEqual([])
  })
})

type ControlBehavior =
  | 'withheld'
  | 'malformed'
  | 'late'
  | 'configured'
  | 'turn-handshake'
  | 'turn-refusal'

class BrokerControlDouble {
  readonly frames: AgentHarnessControlFrame[] = []
  readonly protocolErrors: unknown[] = []
  readonly #ackedRequestIds = new Set<string>()
  readonly nacks: Array<{ requestId: string; code: unknown; message: unknown }> = []
  readonly #pendingRequestIds: string[] = []
  readonly #sockets = new Set<Socket>()
  readonly #waiters = new Set<() => void>()
  readonly #tempDirectory: string
  readonly #server: Server
  readonly #behavior: ControlBehavior
  readonly #config: AgentHarnessSessionConfig

  #buffer = ''

  private constructor(
    readonly socketPath: string,
    tempDirectory: string,
    server: Server,
    behavior: ControlBehavior,
    config: AgentHarnessSessionConfig
  ) {
    this.#tempDirectory = tempDirectory
    this.#server = server
    this.#behavior = behavior
    this.#config = config
  }

  static async start(
    behavior: ControlBehavior,
    config: AgentHarnessSessionConfig = deliveredConfig
  ): Promise<BrokerControlDouble> {
    const tempDirectory = await mkdtemp('/tmp/ah-red-')
    const socketPath = join(tempDirectory, 'control.sock')
    const server = createServer()
    const control = new BrokerControlDouble(socketPath, tempDirectory, server, behavior, config)
    server.on('connection', (socket) => control.#accept(socket))
    controls.push(control)

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    return control
  }

  async waitForFrame(verb: AgentHarnessControlFrame['verb']): Promise<void> {
    await this.#waitUntil(() => this.frames.some((frame) => frame.verb === verb))
  }

  async waitForAck(requestId: string): Promise<void> {
    await this.#waitUntil(() => this.#ackedRequestIds.has(requestId))
  }

  async waitForNack(requestId: string): Promise<void> {
    await this.#waitUntil(() => this.nacks.some((nack) => nack.requestId === requestId))
  }

  /** Offer a turn AFTER the initial handshake, on the still-open channel. */
  sendTurnBegin(requestId: string, turnId: string): void {
    const socket = [...this.#sockets][0]
    if (socket === undefined) throw new Error('no live agent-harness control connection')
    this.#send(socket, turnBeginFrame(requestId, turnId))
  }

  sendTurnInterrupt(requestId: string, reason: string): void {
    const socket = [...this.#sockets][0]
    if (socket === undefined) throw new Error('no live agent-harness control connection')
    this.#send(socket, turnInterruptFrame(requestId, reason))
  }

  acked(requestId: string): boolean {
    return this.#ackedRequestIds.has(requestId)
  }

  async dispose(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
    await rm(this.#tempDirectory, { recursive: true, force: true })
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.#acceptChunk(socket, chunk))
    socket.on('close', () => this.#sockets.delete(socket))
  }

  #acceptChunk(socket: Socket, chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.length > 0) this.#acceptLine(socket, line)
      newline = this.#buffer.indexOf('\n')
    }
  }

  #acceptLine(socket: Socket, line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (typeof value['ack'] === 'boolean') {
        // Correlate by the echoed requestId when the child sends one; the FIFO
        // shift is the fallback and keeps the pending list honest either way.
        const echoed = typeof value['requestId'] === 'string' ? value['requestId'] : undefined
        const shifted = this.#pendingRequestIds.shift()
        const requestId = echoed ?? shifted
        if (requestId !== undefined) {
          if (value['ack'] === true) this.#ackedRequestIds.add(requestId)
          else this.nacks.push({ requestId, code: value['code'], message: value['message'] })
        }
        this.#notify()
        return
      }
      const frame = validateAgentHarnessControlFrame(value)
      this.frames.push(frame)
      this.#respond(socket, frame)
      this.#notify()
    } catch (error) {
      this.protocolErrors.push(error)
      this.#notify()
    }
  }

  #respond(socket: Socket, frame: AgentHarnessControlFrame): void {
    if (frame.verb === 'hello') {
      if (this.#behavior === 'withheld') {
        socket.end()
        return
      }
      if (this.#behavior === 'malformed') {
        socket.end(
          '{"verb":"session.config","requestId":"malformed-config","payload":{"permissionPolicy":{"mode":"deny"}}}\n'
        )
        return
      }
      if (this.#behavior === 'late') {
        this.#send(socket, turnBeginFrame())
        this.#send(socket, sessionConfigFrame(this.#config))
        return
      }
      this.#send(socket, sessionConfigFrame(this.#config))
      return
    }

    if (
      frame.verb === 'ready' &&
      (this.#behavior === 'turn-handshake' || this.#behavior === 'turn-refusal')
    ) {
      this.#send(socket, turnBeginFrame())
    }
  }

  #send(socket: Socket, frame: AgentHarnessControlFrame): void {
    if (
      frame.verb === 'session.config' ||
      frame.verb === 'turn.begin' ||
      frame.verb === 'turn.interrupt'
    ) {
      this.#pendingRequestIds.push(frame.requestId)
    }
    socket.write(encodeAgentHarnessControlFrame(frame))
  }

  async #waitUntil(predicate: () => boolean): Promise<void> {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters.delete(check)
        reject(new Error('Timed out waiting for agent-harness control traffic'))
      }, 1_000)
      const check = () => {
        if (!predicate()) return
        clearTimeout(timeout)
        this.#waiters.delete(check)
        resolve()
      }
      this.#waiters.add(check)
    })
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) waiter()
  }
}

function sessionConfigFrame(
  config: AgentHarnessSessionConfig
): AgentHarnessControlSessionConfigFrame {
  return {
    verb: 'session.config',
    requestId: CONFIG_REQUEST_ID,
    payload: config,
  }
}

function turnBeginFrame(
  requestId: string = TURN_REQUEST_ID,
  turnId: string = BROKER_TURN_ID
): AgentHarnessControlFrame {
  return {
    verb: 'turn.begin',
    requestId,
    payload: {
      turnId,
      inputId: `input-for-${turnId}`,
      structured: false,
    },
  }
}

function turnInterruptFrame(requestId: string, reason: string): AgentHarnessControlFrame {
  return {
    verb: 'turn.interrupt',
    requestId,
    payload: { reason },
  }
}

function constructionSentinels(): {
  calls: string[]
  dependencies: ForegroundTuiDependencies
} {
  const calls: string[] = []
  const runtime = fakeRuntime()
  return {
    calls,
    dependencies: {
      async loadAgent() {
        calls.push('loadAgent')
        return fakeResolvedAgent()
      },
      async createRuntime() {
        calls.push('createRuntime')
        return runtime
      },
      async runInteractiveMode() {
        calls.push('session')
      },
    },
  }
}

function runtimeHarness(
  options: {
    environment?: NodeJS.ProcessEnv
    profileYolo?: boolean
    onLoad?: (options: LoadAgentOptions) => void
    onCreate?: (options: CreateAgentHarnessRuntimeOptions) => void
    onAbort?: () => void | Promise<void>
    onInteractive?: () => void | Promise<void>
  } = {}
) {
  let subscriber: ((event: AgentSessionEvent) => void) | undefined
  let toolCallHandler: ((event: ToolCallEvent) => unknown | Promise<unknown>) | undefined
  const runtime = fakeRuntime((listener) => {
    subscriber = listener
  }, options.onAbort)

  return {
    dependencies: {
      async loadAgent(loadOptions: LoadAgentOptions) {
        options.onLoad?.(loadOptions)
        return fakeResolvedAgent(options.environment, options.profileYolo)
      },
      async createRuntime(runtimeOptions: CreateAgentHarnessRuntimeOptions) {
        options.onCreate?.(runtimeOptions)
        for (const extension of runtimeOptions.extensionFactories ?? []) {
          await extension({
            on(event: string, handler: (event: ToolCallEvent) => unknown) {
              if (event === 'tool_call') toolCallHandler = handler
            },
          } as never)
        }
        return runtime
      },
      async runInteractiveMode() {
        await options.onInteractive?.()
      },
    } satisfies ForegroundTuiDependencies,
    emitSessionEvent(event: AgentSessionEvent) {
      subscriber?.(event)
    },
    hasSessionSubscriber(): boolean {
      return subscriber !== undefined
    },
    async invokeToolCall(event: ToolCallEvent): Promise<unknown> {
      return toolCallHandler?.(event)
    },
  }
}

function fakeRuntime(
  onSubscribe?: (listener: (event: AgentSessionEvent) => void) => void,
  onAbort?: () => void | Promise<void>
): AgentSessionRuntime {
  return {
    session: {
      sessionFile: '/tmp/agent-harness-session-07566.jsonl',
      subscribe(listener: (event: AgentSessionEvent) => void) {
        onSubscribe?.(listener)
        return () => {}
      },
      async abort() {
        await onAbort?.()
      },
    },
    async dispose() {},
  } as unknown as AgentSessionRuntime
}

function fakeResolvedAgent(
  environment: NodeJS.ProcessEnv = {},
  profileYolo = false
): ResolvedAgent {
  return {
    input: { agentId: 'smokey' },
    agentId: 'smokey',
    aspHome: '/tmp/asp-home',
    placement: {
      agentRoot: '/tmp/agents/smokey',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: 'smokey' },
    },
    model: {
      id: 'anthropic/claude-sonnet-4-5',
      piProvider: 'anthropic',
      piModelId: 'claude-sonnet-4-5',
      authMode: 'oauth',
    },
    environment,
    sources: {
      effectiveConfig: { yolo: profileYolo },
    },
    skillPaths: [],
    warnings: [],
  } as unknown as ResolvedAgent
}

function assistantDelta(text: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: text },
  } as AgentSessionEvent
}

async function captureFailure(operation: Promise<void>): Promise<unknown> {
  try {
    await operation
    return undefined
  } catch (error) {
    return error
  }
}
