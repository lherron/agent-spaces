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

const deliveredConfig = {
  permissionPolicy: { mode: 'deny' },
  auth: {
    authMode: 'oauth',
    authPath: '/broker/credentials/auth.json',
    providerId: 'anthropic',
    credentialType: 'oauth',
    storeBound: true,
  },
  sdk: {
    modelId: 'claude-sonnet-4-5',
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

  test('binds delivered auth before runtime creation and never consults foreground auth', async () => {
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
      provider: deliveredConfig.auth.providerId,
      reasoningEffort: deliveredConfig.sdk.thinkingLevel,
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
})

type ControlBehavior = 'withheld' | 'malformed' | 'late' | 'configured' | 'turn-handshake'

class BrokerControlDouble {
  readonly frames: AgentHarnessControlFrame[] = []
  readonly protocolErrors: unknown[] = []
  readonly #ackedRequestIds = new Set<string>()
  readonly #pendingRequestIds: string[] = []
  readonly #sockets = new Set<Socket>()
  readonly #waiters = new Set<() => void>()
  readonly #tempDirectory: string
  readonly #server: Server
  readonly #behavior: ControlBehavior

  #buffer = ''

  private constructor(
    readonly socketPath: string,
    tempDirectory: string,
    server: Server,
    behavior: ControlBehavior
  ) {
    this.#tempDirectory = tempDirectory
    this.#server = server
    this.#behavior = behavior
  }

  static async start(behavior: ControlBehavior): Promise<BrokerControlDouble> {
    const tempDirectory = await mkdtemp('/tmp/ah-red-')
    const socketPath = join(tempDirectory, 'control.sock')
    const server = createServer()
    const control = new BrokerControlDouble(socketPath, tempDirectory, server, behavior)
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
      if (value['ack'] === true) {
        const requestId = this.#pendingRequestIds.shift()
        if (requestId !== undefined) this.#ackedRequestIds.add(requestId)
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
        this.#send(socket, sessionConfigFrame())
        return
      }
      this.#send(socket, sessionConfigFrame())
      return
    }

    if (frame.verb === 'ready' && this.#behavior === 'turn-handshake') {
      this.#send(socket, turnBeginFrame())
    }
  }

  #send(socket: Socket, frame: AgentHarnessControlFrame): void {
    if (frame.verb === 'session.config' || frame.verb === 'turn.begin') {
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

function sessionConfigFrame(): AgentHarnessControlSessionConfigFrame {
  return {
    verb: 'session.config',
    requestId: CONFIG_REQUEST_ID,
    payload: deliveredConfig,
  }
}

function turnBeginFrame(): AgentHarnessControlFrame {
  return {
    verb: 'turn.begin',
    requestId: TURN_REQUEST_ID,
    payload: {
      turnId: BROKER_TURN_ID,
      inputId: 'input-07566',
      structured: false,
    },
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
    onInteractive?: () => void | Promise<void>
  } = {}
) {
  let subscriber: ((event: AgentSessionEvent) => void) | undefined
  let toolCallHandler: ((event: ToolCallEvent) => unknown | Promise<unknown>) | undefined
  const runtime = fakeRuntime((listener) => {
    subscriber = listener
  })

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
  onSubscribe?: (listener: (event: AgentSessionEvent) => void) => void
): AgentSessionRuntime {
  return {
    session: {
      sessionFile: '/tmp/agent-harness-session-07566.jsonl',
      subscribe(listener: (event: AgentSessionEvent) => void) {
        onSubscribe?.(listener)
        return () => {}
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
