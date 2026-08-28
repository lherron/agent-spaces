import { type Socket, createConnection } from 'node:net'
import { type AgentSessionRuntime, InteractiveMode } from '@earendil-works/pi-coding-agent'
import {
  type LoadAgentOptions,
  RESOURCE_LOADER_THEME_NAME,
  createAgentHarnessRuntime,
  loadAgent,
} from 'agent-harness-runtime'
import {
  PiSdkTurnAlreadyActiveError,
  PiSdkTurnEventMapper,
  type PiSdkTurnEventMapperOptions,
  createPiSdkPermissionBridge,
} from 'spaces-harness-broker-pi-sdk'
import {
  AGENT_HARNESS_CONTROL_PROTOCOL_VERSION,
  type AgentHarnessControlAck,
  AgentHarnessControlDecoder,
  type AgentHarnessControlFrame,
  type AgentHarnessControlNackCode,
  type AgentHarnessControlSessionConfigFrame,
  type AgentHarnessControlTurnBeginFrame,
  type AgentHarnessSessionConfig,
  type InputId,
  type InvocationEvent,
  type InvocationEventEnvelope,
  type InvocationEventPayloadMap,
  type InvocationEventType,
  type InvocationId,
  type TurnId,
  encodeAgentHarnessControlFrame,
  validateAgentHarnessControlAck,
  validateAgentHarnessSessionConfig,
  validateEventEnvelope,
} from 'spaces-harness-broker-protocol'

import { resolveForegroundAuthStorePath } from './auth-store.js'

/**
 * Driver kind stamped on every event this TUI emits. Must match the broker-side
 * `AGENT_HARNESS_TMUX_DRIVER_KIND`; the two sides label the same driver.
 */
const AGENT_HARNESS_DRIVER_KIND = 'agent-harness-tmux'

export interface ForegroundTuiDependencies {
  loadAgent: typeof loadAgent
  createRuntime: typeof createAgentHarnessRuntime
  runInteractiveMode: (runtime: AgentSessionRuntime, initialMessage?: string) => Promise<void>
}

const productionDependencies: ForegroundTuiDependencies = {
  loadAgent,
  createRuntime: createAgentHarnessRuntime,
  async runInteractiveMode(runtime, initialMessage) {
    await new InteractiveMode(runtime, {
      ...(initialMessage !== undefined ? { initialMessage } : {}),
      initialThemeSetting: RESOURCE_LOADER_THEME_NAME,
    }).run()
  },
}

/** Run a local Pi TUI using the same shared runtime as the broker facade. */
export async function runAgentHarnessTui(
  options: LoadAgentOptions & {
    brokerControlSocket?: string | undefined
    prompt?: string | undefined
    resume?: string | boolean | undefined
  },
  dependencies: ForegroundTuiDependencies = productionDependencies
): Promise<void> {
  if (options.brokerControlSocket !== undefined) {
    await runBrokerAgentHarnessTui(
      { ...options, brokerControlSocket: options.brokerControlSocket },
      dependencies
    )
    return
  }

  const agent = await dependencies.loadAgent(options)
  const runtime = await dependencies.createRuntime({
    agent,
    authStorePath: resolveForegroundAuthStorePath(agent.environment),
    ...(options.resume !== undefined ? { continuationKey: options.resume } : {}),
  })
  try {
    await dependencies.runInteractiveMode(runtime, options.prompt)
  } finally {
    await runtime.dispose()
  }
}

async function runBrokerAgentHarnessTui(
  options: LoadAgentOptions & {
    brokerControlSocket: string
    prompt?: string | undefined
    resume?: string | boolean | undefined
  },
  dependencies: ForegroundTuiDependencies
): Promise<void> {
  const control = await BrokerControlConnection.connect(options.brokerControlSocket)
  let runtime: AgentSessionRuntime | undefined
  let driverContext: PiSdkTurnEventMapperOptions['ctx'] | undefined
  let announced = false

  /**
   * Tell the broker the operator left. Idempotent: the shutdown event can be
   * emitted more than once across a teardown, and a second clear would be noise
   * on the ledger.
   */
  const announceUserExit = async (): Promise<void> => {
    if (announced || driverContext === undefined) return
    announced = true
    driverContext.emit(
      'continuation.cleared',
      { reason: USER_EXIT_REASON },
      { driver: { kind: AGENT_HARNESS_DRIVER_KIND, rawType: 'tui.user_exit' } }
    )
    // The bytes must reach the kernel before pi's `process.exit(0)`, which
    // follows this handler by only a few statements. Without the flush the
    // goodbye is still sitting in the socket's write buffer when the process
    // dies, and the broker sees nothing but a disconnect.
    await control.flush()
  }

  try {
    const config = await control.config
    assertSupportedPermissionPolicy(config)

    driverContext = createBrokerTuiDriverContext(config, control)
    const mapper = new PiSdkTurnEventMapper({
      ctx: driverContext,
      provider: config.auth.providerId,
      sessionFile: () => runtime?.session.sessionFile,
      driverKind: AGENT_HARNESS_DRIVER_KIND,
    })
    control.onTurnBegin = (frame) => {
      mapper.beginTurn({
        turnId: frame.payload.turnId as TurnId,
        inputId: frame.payload.inputId as InputId,
        structured: false,
      })
    }

    const agent = await dependencies.loadAgent({
      ...config.agent,
      model: config.sdk.modelId,
      provider:
        config.auth.providerId === 'anthropic' || config.auth.providerId === 'openai'
          ? config.auth.providerId
          : undefined,
      ...(config.sdk.thinkingLevel !== undefined
        ? { reasoningEffort: config.sdk.thinkingLevel }
        : {}),
    })
    const permissionBridge = createPiSdkPermissionBridge({
      ctx: driverContext,
      policy: config.permissionPolicy,
      activeTurnId: () => mapper.activeTurnId,
      driverKind: AGENT_HARNESS_DRIVER_KIND,
    })
    runtime = await dependencies.createRuntime({
      agent,
      auth: {
        authMode: config.auth.authMode,
        authPath: config.auth.authPath,
        providerId: config.auth.providerId,
      },
      // Mirrors broker/invocation-session-factory.ts:55-57. Absent means the
      // runtime creates a fresh session; a key means resume THAT session.
      ...(config.continuation?.key !== undefined
        ? { continuationKey: config.continuation.key }
        : {}),
      extensionFactories: [
        (pi) => {
          pi.on('tool_call', (event) => permissionBridge.handle(event))
          // The ONLY reliable `/quit` signal. Pi's InteractiveMode ends the
          // session with `process.exit(0)` (interactive-mode.js:3227), so
          // `runInteractiveMode` never returns and no `finally` of ours runs.
          // `session_shutdown` is emitted from AgentSessionRuntime.dispose()
          // and AWAITED before that exit, which also means the session file is
          // already persisted when we announce — exactly the ordering HRC needs,
          // since it reaps the tmux lease as soon as it records the summary.
          pi.on('session_shutdown', async (event) => {
            // 'quit' is the operator LEAVING. 'new'/'resume'/'fork' are session
            // REPLACEMENT and 'reload' is an extension-runtime bounce: the
            // session continues, so announcing a user exit for those would drop
            // a continuation that is still wanted (T-01761).
            if (event.reason !== 'quit') return
            await announceUserExit()
          })
        },
      ],
    })
    runtime.session.subscribe((event) => mapper.handle(event))
    const sessionFile = runtime.session.sessionFile
    if (sessionFile === undefined) throw new Error('Broker TUI session has no session file')
    control.send({
      verb: 'ready',
      payload: { sessionFile },
    })
    await dependencies.runInteractiveMode(runtime, options.prompt)
  } finally {
    // Reached only when the TUI returns instead of exiting the process (the
    // injected-dependency path in tests, and any future non-exiting mode).
    // dispose() re-emits `session_shutdown`, so the announcement still runs
    // through the one hook above rather than a second code path here.
    await runtime?.dispose()
    control.close()
  }
}

/**
 * The `continuation.cleared` reason that means "the operator LEFT" rather than
 * "the session was reset". It is the single event the whole graceful-exit chain
 * hangs off: the broker answers it with an authoritative `invocation.summary`
 * (invocation-manager `SESSION_LEAVE_REASONS`), and HRC answers that pair with a
 * summary-aware tmux lease reap plus the `hrc run` post-detach session summary.
 * Mirrors what Claude Code's own SessionEnd hook reports on `/quit`.
 */
const USER_EXIT_REASON = 'prompt_input_exit'

function assertSupportedPermissionPolicy(config: AgentHarnessSessionConfig): void {
  if (config.permissionPolicy.mode === 'ask-client') {
    throw new Error('agent-harness TUI broker mode does not support ask-client permission policy')
  }
}

function createBrokerTuiDriverContext(
  config: AgentHarnessSessionConfig,
  control: BrokerControlConnection
): PiSdkTurnEventMapperOptions['ctx'] {
  const invocationId = (config.agent.scopeRef ?? config.agent.agentId) as InvocationId
  let sequence = 0
  const emit = (
    type: InvocationEventType,
    payload: InvocationEventPayloadMap[InvocationEventType],
    extra?: {
      turnId?: TurnId | undefined
      inputId?: InputId | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
      harnessGeneration?: number | undefined
      turnAttempt?: number | undefined
    }
  ): InvocationEventEnvelope => {
    const event = validateEventEnvelope({
      invocationId,
      seq: ++sequence,
      time: new Date().toISOString(),
      type,
      payload,
      ...extra,
    })
    control.send({ verb: 'event', payload: event })
    return event
  }
  return {
    invocationId,
    clientCapabilities: {},
    emit: emit as PiSdkTurnEventMapperOptions['ctx']['emit'],
    emitEvent: ((event: InvocationEvent, extra?: Parameters<typeof emit>[2]) =>
      emit(event.type, event.payload, extra)) as PiSdkTurnEventMapperOptions['ctx']['emitEvent'],
  } as PiSdkTurnEventMapperOptions['ctx']
}

class BrokerControlConnection {
  readonly config: Promise<AgentHarnessSessionConfig>
  onTurnBegin: ((frame: AgentHarnessControlTurnBeginFrame) => void) | undefined

  #resolveConfig: ((config: AgentHarnessSessionConfig) => void) | undefined
  #rejectConfig: ((error: Error) => void) | undefined
  #configured = false
  #failed = false
  #decoder = new AgentHarnessControlDecoder()

  private constructor(readonly socket: Socket) {
    this.config = new Promise<AgentHarnessSessionConfig>((resolve, reject) => {
      this.#resolveConfig = resolve
      this.#rejectConfig = reject
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.#receive(chunk))
    socket.on('error', (error) => this.#fail(error))
    socket.on('close', () => {
      if (!this.#configured)
        this.#fail(new Error('Broker control socket closed before session.config'))
    })
  }

  static async connect(socketPath: string): Promise<BrokerControlConnection> {
    const socket = createConnection(socketPath)
    const control = new BrokerControlConnection(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    control.send({
      verb: 'hello',
      payload: { protocolVersion: AGENT_HARNESS_CONTROL_PROTOCOL_VERSION },
    })
    return control
  }

  send(frame: Extract<AgentHarnessControlFrame, { verb: 'hello' | 'ready' | 'event' }>): void {
    if (this.#failed) return
    this.socket.write(encodeAgentHarnessControlFrame(frame))
  }

  /**
   * Resolve once everything already written has been handed to the kernel.
   *
   * `send` is fire-and-forget, which is fine for every frame that is followed by
   * more session; it is NOT fine for the last frame before pi calls
   * `process.exit(0)`. Bounded so a wedged socket can never hold up the
   * operator's quit — losing the goodbye degrades to the driver's disconnect
   * path, which is the correct crash-shaped fallback.
   */
  flush(timeoutMs = 1000): Promise<void> {
    if (this.#failed || this.socket.destroyed || this.socket.writableLength === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.socket.off('drain', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      this.socket.once('drain', done)
    })
  }

  close(): void {
    if (!this.socket.destroyed) this.socket.end()
  }

  #receive(chunk: string): void {
    for (const result of this.#decoder.push(chunk)) {
      if (!result.ok) {
        this.#fail(
          new Error('Broker control socket sent an invalid frame', { cause: result.error })
        )
        return
      }
      this.#receiveFrame(result.value)
      if (this.#failed) return
    }
  }

  #receiveFrame(frame: AgentHarnessControlFrame): void {
    if (frame.verb === 'session.config') {
      this.#receiveConfig(frame)
      return
    }
    if (frame.verb === 'turn.begin') {
      if (!this.#configured || this.onTurnBegin === undefined) {
        this.#fail(new Error('Broker control socket sent turn.begin before the TUI was ready'))
        return
      }
      try {
        this.onTurnBegin(frame)
        this.#ack(frame.requestId)
      } catch (error) {
        // A turn we cannot bind is a RECOVERABLE turn failure, not a crash. The
        // mapper throws before it reassigns #turnId, so the runtime, the live
        // turn, and this channel are all still intact — say so on the wire and
        // stay up. Destroying here would make "I cannot begin this turn"
        // indistinguishable from "I died" and would take the whole invocation
        // down for one refused turn.
        this.#nack(frame.requestId, error)
      }
      return
    }
    this.#fail(new Error(`Broker control socket sent unexpected ${frame.verb} frame`))
  }

  #receiveConfig(frame: AgentHarnessControlSessionConfigFrame): void {
    if (this.#configured) {
      this.#fail(new Error('Broker control socket sent session.config more than once'))
      return
    }
    try {
      const config = validateAgentHarnessSessionConfig(frame.payload)
      this.#ack(frame.requestId)
      this.#configured = true
      this.#resolveConfig?.(config)
    } catch (error) {
      this.#fail(error)
    }
  }

  #fail(error: unknown): void {
    if (this.#failed) return
    this.#failed = true
    this.#rejectConfig?.(error instanceof Error ? error : new Error(String(error)))
    if (!this.socket.destroyed) this.socket.destroy()
  }

  #ack(requestId: string): void {
    this.#writeAck({ ack: true, requestId })
  }

  #nack(requestId: string, error: unknown): void {
    const code: AgentHarnessControlNackCode =
      error instanceof PiSdkTurnAlreadyActiveError ? 'turn_already_active' : 'turn_begin_failed'
    this.#writeAck({
      ack: false,
      requestId,
      code,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  #writeAck(line: AgentHarnessControlAck & { requestId: string }): void {
    if (this.#failed) return
    validateAgentHarnessControlAck(line)
    this.socket.write(`${JSON.stringify(line)}\n`)
  }
}
