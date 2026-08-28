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
  let userExited = false
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
    // A CLEAN return from the TUI means the operator left the session (`/quit`).
    // A throw does not: it is a crash, and must keep the continuation so the
    // runtime stays resumable on reattach (T-01761).
    userExited = true
  } finally {
    await runtime?.dispose()
    // Announce the user exit only AFTER dispose has persisted the session. HRC
    // reaps the tmux lease as soon as it has recorded the summary this event
    // triggers, so announcing first races the pane kill against our own
    // session write. A dispose that throws skips the announcement on purpose:
    // we cannot claim a clean exit for a session we failed to close.
    if (userExited) {
      announceUserExit(driverContext)
    }
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

/**
 * Tell the broker the operator quit.
 *
 * Unlike the codex CLI — a third-party binary that emits nothing on `/quit`, and
 * so needs the launch runner's synthetic SessionEnd — this TUI is our own code
 * and already speaks the control protocol, so it can just say so. Riding the
 * existing `event` verb keeps this inside `agent-harness-control/v1`: no new
 * verb, no protocol version bump.
 *
 * Best-effort by construction. The driver treats a silent disconnect as a crash,
 * which is the correct fallback for every path that cannot get a word out.
 */
function announceUserExit(driverContext: PiSdkTurnEventMapperOptions['ctx'] | undefined): void {
  try {
    driverContext?.emit(
      'continuation.cleared',
      { reason: USER_EXIT_REASON },
      { driver: { kind: AGENT_HARNESS_DRIVER_KIND, rawType: 'tui.user_exit' } }
    )
  } catch {
    // Never let the goodbye stop the goodbye: a failed announcement degrades to
    // the driver's disconnect path, it must not throw out of the finally block.
  }
}

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
