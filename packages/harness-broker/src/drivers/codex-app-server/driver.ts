import { createInterface } from 'node:readline'
import type {
  CodexAppServerDriverSpec,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { spawnHarnessProcess } from '../../runtime/process-runner'
import { terminateProcess } from '../../runtime/signals'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { createCodexNotificationMapper, parseCodexError } from './event-map'
import { buildTurnStartParams } from './input'
import {
  type PermissionHandlerContext,
  createPermissionRequestIdAllocator,
  handlePermissionRequest,
} from './permissions'
import { CodexRpcClient, CodexRpcError, type JsonRpcNotification } from './rpc-client'

const bunRuntime =
  typeof Bun !== 'undefined' ? (Bun as unknown as { execPath?: string }) : undefined
if (bunRuntime !== undefined && bunRuntime.execPath === undefined) {
  Object.defineProperty(Bun, 'execPath', {
    value: process.execPath,
    configurable: true,
  })
}

const CODEX_CAPABILITIES: InvocationCapabilities = {
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: true,
    fileRefs: false,
    queue: true,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'unsupported',
  },
  continuation: {
    supported: true,
    provider: 'codex',
    keyKind: 'thread',
  },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: true,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

interface ThreadResponse {
  threadId?: string | undefined
  thread?: { id?: string | undefined } | undefined
}

type ChildProcess = Awaited<ReturnType<typeof spawnHarnessProcess>>

export function createCodexAppServerDriver(): Driver {
  let ctx: DriverContext | undefined
  let spec: HarnessInvocationSpec | undefined
  let driverSpec: CodexAppServerDriverSpec | undefined
  let proc: ChildProcess | undefined
  let rpc: CodexRpcClient | undefined
  let threadId: string | undefined
  let currentInputId: InputId | undefined
  let currentTurnId: TurnId | undefined
  let turnActive = false
  let startedEmitted = false
  let terminalEmitted = false
  let stopping = false
  let starting = false
  let rejectStartup: ((error: Error) => void) | undefined
  let startupFailure: Promise<never> | undefined
  let turnTimeout: ReturnType<typeof setTimeout> | undefined
  const mapCodexNotification = createCodexNotificationMapper()
  const permissionRequestIds = createPermissionRequestIdAllocator()

  function requireCtx(): DriverContext {
    if (!ctx) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function emitDiagnostic(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown
  ): void {
    requireCtx().emit('diagnostic', {
      level,
      message,
      source: 'harness',
      ...(data !== undefined ? { data } : {}),
    })
  }

  function emitTerminalFailure(message: string, code?: string, data?: unknown): void {
    if (terminalEmitted) return
    terminalEmitted = true
    requireCtx().emit('invocation.failed', {
      message,
      ...(code !== undefined ? { code } : {}),
      ...(data !== undefined ? { data } : {}),
    })
  }

  function onNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'error') {
      const error = parseCodexError(notification.params)
      emitDiagnostic(
        'error',
        error.message,
        error.code !== undefined ? { code: error.code } : error.data
      )
      if (turnActive && currentTurnId) {
        requireCtx().emit(
          'turn.failed',
          {
            turnId: currentTurnId,
            status: 'failed',
            finalOutput: error.message,
          },
          { turnId: currentTurnId, inputId: currentInputId }
        )
      } else {
        emitTerminalFailure(error.message, error.code)
      }

      if (starting) {
        rejectStartup?.(
          new BrokerError(BrokerErrorCode.HarnessError, error.message, {
            code: error.code,
            data: error.data,
          })
        )
      }
      return
    }

    // After any invocation-terminal event, drop further native events so a late
    // turn/completed (or any other notification) can never follow a terminal.
    if (terminalEmitted) return

    for (const mapped of mapCodexNotification(notification)) {
      const isTurnTerminal =
        mapped.type === 'turn.completed' ||
        mapped.type === 'turn.failed' ||
        mapped.type === 'turn.interrupted'
      // Suppress a turn terminal for a turn that already reached a terminal
      // state (e.g. a turn-timeout turn.failed followed by a late turn/completed).
      if (isTurnTerminal && !turnActive) continue
      const extra =
        mapped.type === 'turn.started' || isTurnTerminal
          ? { ...mapped.extra, inputId: currentInputId }
          : mapped.extra
      const event = requireCtx().emit(mapped.type, mapped.payload, extra)
      if (event.type === 'turn.started') {
        currentTurnId = event.turnId
        turnActive = true
      }
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted'
      ) {
        turnActive = false
        // Clear turn timeout on any turn termination
        if (turnTimeout !== undefined) {
          clearTimeout(turnTimeout)
          turnTimeout = undefined
        }
      }
    }
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!startedEmitted || terminalEmitted) {
      if (starting) {
        rejectStartup?.(
          new BrokerError(BrokerErrorCode.HarnessError, 'Harness process exited during startup', {
            exitCode: code,
            signal,
          })
        )
      }
      return
    }

    if (turnActive && currentTurnId) {
      requireCtx().emit(
        stopping ? 'turn.interrupted' : 'turn.failed',
        {
          turnId: currentTurnId,
          status: stopping ? 'interrupted' : 'failed',
          ...(!stopping ? { finalOutput: 'Harness process exited during active turn' } : {}),
        },
        { turnId: currentTurnId, inputId: currentInputId }
      )
      turnActive = false
    }

    terminalEmitted = true
    requireCtx().emit('invocation.exited', { exitCode: code, signal })
  }

  async function startThread(): Promise<string> {
    if (!rpc || !spec || !driverSpec) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver is not initialized')
    }

    const resumeThreadId =
      driverSpec.resumeThreadId ??
      (spec.continuation?.provider === 'codex' ? spec.continuation.key : undefined)

    const startParams = buildThreadStartParams(spec, driverSpec)
    if (!resumeThreadId) {
      return extractThreadId(await rpc.sendRequest<ThreadResponse>('thread/start', startParams))
    }

    try {
      return extractThreadId(
        await rpc.sendRequest<ThreadResponse>('thread/resume', {
          ...startParams,
          threadId: resumeThreadId,
          history: null,
          path: null,
        })
      )
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error
      }

      if ((driverSpec.resumeFallback ?? 'start-fresh') === 'fail') {
        const message = error instanceof Error ? error.message : 'Thread not found'
        const code = error instanceof CodexRpcError ? extractErrorCode(error) : undefined
        emitDiagnostic('error', message, code !== undefined ? { code } : undefined)
        emitTerminalFailure(message, code)
        throw new BrokerError(BrokerErrorCode.HarnessError, message, { code })
      }

      requireCtx().emit('driver.notice', {
        message: `Codex thread ${resumeThreadId} was not found; starting a fresh thread`,
        code: 'resume_fallback_start_fresh',
        data: { missingThreadId: resumeThreadId },
      })
      return extractThreadId(await rpc.sendRequest<ThreadResponse>('thread/start', startParams))
    }
  }

  return {
    kind: 'codex-app-server',
    version: '0.1.0',

    capabilities(): InvocationCapabilities {
      return CODEX_CAPABILITIES
    },

    async start(
      startSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      if (startSpec.driver.kind !== 'codex-app-server') {
        throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid Codex driver spec')
      }

      ctx = driverCtx
      spec = startSpec
      driverSpec = startSpec.driver as CodexAppServerDriverSpec
      const activeDriverSpec = driverSpec
      terminalEmitted = false
      startedEmitted = false
      stopping = false
      starting = true
      startupFailure = new Promise<never>((_resolve, reject) => {
        rejectStartup = reject
      })
      // Prevent unhandled rejection when startupFailure outlives the race
      startupFailure.catch(() => {})

      // Codex credentials live on disk (auth.json via CODEX_HOME, a lockedEnv
      // path) — the credentials channel is empty. Only the per-invocation
      // dispatchEnv rides alongside the lockedEnv from the spec.
      proc = await spawnHarnessProcess(startSpec.process, {
        credentials: {},
        ...(driverCtx.dispatchEnv !== undefined ? { dispatchEnv: driverCtx.dispatchEnv } : {}),
      })
      proc.on('exit', onExit)
      createInterface({ input: proc.stderr }).on('line', (line) => {
        if (line.trim().length > 0) {
          emitDiagnostic('info', line)
        }
      })

      const rpcClient = new CodexRpcClient(proc, {
        onNotification,
        onRequest: async (request) => {
          const permCtx: PermissionHandlerContext = {
            ctx: requireCtx(),
            driver: activeDriverSpec,
            currentTurnId,
            currentInputId,
            permissionRequestIds,
          }
          return handlePermissionRequest(request, permCtx)
        },
        onError: (error) => {
          if (starting) {
            rejectStartup?.(error)
          }
        },
      })
      rpc = rpcClient

      // Wire startup timeout — timer starts when the first RPC is written,
      // so process boot time doesn't count against the limit.
      const startupTimeoutMs = startSpec.process.limits?.startupTimeoutMs
      let startupTimedOut = false
      let startupTimer: ReturnType<typeof setTimeout> | undefined

      function armStartupTimer(): void {
        if (startupTimer !== undefined) clearTimeout(startupTimer)
        if (startupTimeoutMs === undefined || startupTimeoutMs <= 0) return
        startupTimer = setTimeout(() => {
          if (!starting) return
          startupTimedOut = true
          emitTerminalFailure('Startup timed out', 'Timeout')
          rpc?.close(new Error('Startup timed out'))
          if (proc && proc.exitCode === null) proc.kill('SIGTERM')
          rejectStartup?.(new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out'))
        }, startupTimeoutMs)
      }

      try {
        armStartupTimer()
        const initializeResult = await withStartupRace(
          rpcClient.sendRequest('initialize', {
            clientInfo: { name: 'harness-broker', version: '0.1.0' },
          })
        )
        validateInitializeHandshake(initializeResult, emitDiagnostic)
        armStartupTimer() // re-arm after successful initialize
        await withStartupRace(rpcClient.sendNotification('initialized', {}))
        armStartupTimer() // re-arm after initialized notification
        threadId = await withStartupRace(startThread())
      } catch (startupErr) {
        if (startupTimer !== undefined) clearTimeout(startupTimer)
        if (startupTimedOut) {
          throw new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out')
        }
        throw startupErr
      }
      if (startupTimer !== undefined) clearTimeout(startupTimer)

      requireCtx().emit('invocation.started', {
        pid: proc.pid,
        command: startSpec.process.command ?? process.execPath,
        args: startSpec.process.args,
        cwd: startSpec.process.cwd,
      })
      startedEmitted = true
      requireCtx().emit('continuation.updated', {
        provider: 'codex',
        kind: 'thread',
        key: threadId,
      })
      requireCtx().emit('invocation.ready', {})
      starting = false
      rejectStartup = undefined
      startupFailure = undefined

      return { ok: true }
    },

    // Driver applies the input immediately — broker manager owns all policy,
    // disposition, and queue semantics. No policy or busy checks here.
    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      if (!rpc || !spec || !driverSpec || !threadId) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready')
      }

      const inputId = input.inputId ?? (`input_${Date.now().toString(36)}` as InputId)
      currentInputId = inputId

      // Wire turn timeout
      const turnTimeoutMs = spec.process.limits?.turnTimeoutMs
      let turnTimedOut = false

      if (turnTimeoutMs !== undefined && turnTimeoutMs > 0) {
        turnTimeout = setTimeout(() => {
          // Skip timeout if stopping/exited — the stop path handles turn teardown
          if (stopping || terminalEmitted) return
          turnTimedOut = true
          if (turnActive && currentTurnId) {
            requireCtx().emit(
              'turn.failed',
              {
                turnId: currentTurnId,
                status: 'failed',
                code: 'Timeout',
              },
              { turnId: currentTurnId, inputId: currentInputId }
            )
            turnActive = false
          }
          // Defer the RPC close to the next event-loop turn so a concurrent
          // stop() (arriving from a same-tick timer) can pre-empt it.
          // stop() clears turnTimeout, cancelling this deferred close.
          turnTimeout = setTimeout(() => {
            if (!stopping && !terminalEmitted) {
              rpc?.close(new Error('Turn timed out'))
            }
          }, 0)
        }, turnTimeoutMs)
      }

      try {
        await rpc.sendRequest(
          'turn/start',
          buildTurnStartParams({
            threadId,
            cwd: spec.process.cwd,
            input,
            driver: driverSpec,
          })
        )
      } catch (error) {
        if (turnTimeout !== undefined) clearTimeout(turnTimeout)
        turnTimeout = undefined
        if (turnTimedOut) {
          if (stopping || terminalEmitted) {
            return { ...(currentTurnId ? { turnId: currentTurnId } : {}) }
          }
          throw new BrokerError(BrokerErrorCode.Timeout, 'Turn timed out')
        }
        if (terminalEmitted || turnActive || stopping) {
          return { ...(currentTurnId ? { turnId: currentTurnId } : {}) }
        }
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          error instanceof Error ? error.message : 'Codex turn failed to start'
        )
      }
      if (turnTimeout !== undefined) clearTimeout(turnTimeout)
      turnTimeout = undefined

      return { ...(currentTurnId ? { turnId: currentTurnId } : {}) }
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (req.scope === 'turn') {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: 'Codex app-server v0 does not support turn interrupt',
        }
      }
      return {
        accepted: false,
        effect: 'unsupported',
        reason: 'Codex app-server v0 interrupt unsupported',
      }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      stopping = true
      // Clear any pending turn timeout; the stop takes precedence.
      if (turnTimeout !== undefined) {
        clearTimeout(turnTimeout)
        turnTimeout = undefined
      }
      if (!proc) {
        return { accepted: false, state: 'failed' }
      }
      await terminateProcess({
        proc,
        graceMs: req.graceMs ?? spec?.process.limits?.stopGraceMs ?? 1000,
      })
      return { accepted: true, state: terminalEmitted ? 'exited' : 'failed' }
    },

    async dispose(): Promise<void> {
      rpc?.close()
      ctx = undefined
      spec = undefined
      driverSpec = undefined
      proc = undefined
      rpc = undefined
      threadId = undefined
      currentInputId = undefined
      currentTurnId = undefined
      turnActive = false
      startedEmitted = false
      terminalEmitted = false
      stopping = false
      starting = false
    },
  }

  async function withStartupRace<T>(work: Promise<T>): Promise<T> {
    if (!startupFailure) return work
    // Attach no-op catch to both sides so the loser doesn't trigger unhandled rejection
    work.catch(() => {})
    return Promise.race([work, startupFailure])
  }
}

type DiagnosticEmitter = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown
) => void

/**
 * Tolerantly validate the Codex `initialize` handshake response.
 *
 * - A clearly-unsupported `protocolVersion` (a string that does not carry the
 *   `codex-app-server/` namespace) is a hard failure: throw HarnessError so the
 *   broker fails the invocation predictably rather than driving an incompatible
 *   server.
 * - A present-but-non-string `protocolVersion`, or a non-object response, is
 *   suspicious but non-critical — emit a `warn` diagnostic and continue.
 * - A missing `protocolVersion` is loose-but-common (do not overfit to the fake
 *   server) — emit a `debug` diagnostic and continue.
 */
export function validateInitializeHandshake(
  result: unknown,
  emitDiagnostic: DiagnosticEmitter
): void {
  if (result === null || typeof result !== 'object') {
    emitDiagnostic('warn', 'Codex initialize response was not an object', {
      received: typeof result,
    })
    return
  }

  const protocolVersion = (result as Record<string, unknown>)['protocolVersion']
  if (typeof protocolVersion === 'string') {
    if (!protocolVersion.startsWith('codex-app-server/')) {
      throw new BrokerError(
        BrokerErrorCode.HarnessError,
        `Unsupported Codex app-server protocol version: ${protocolVersion}`,
        { protocolVersion }
      )
    }
    return
  }

  if (protocolVersion !== undefined) {
    emitDiagnostic('warn', 'Codex initialize protocolVersion was not a string', {
      received: typeof protocolVersion,
    })
    return
  }

  emitDiagnostic('debug', 'Codex initialize response omitted protocolVersion')
}

/**
 * Build `thread/start` params from the driver spec. Every driver-spec field is
 * either forwarded to the native call or deliberately handled elsewhere:
 *  - model / approvalPolicy / sandboxMode: forwarded here.
 *  - profile: forwarded here (Codex app-server selects a config profile).
 *  - modelReasoningEffort: forwarded as a thread-scope `config` override here
 *    AND applied per-turn in buildTurnStartParams(effort).
 *  - defaultImageAttachments: applied per-turn in buildTurnStartParams.
 *  - resumeThreadId / resumeFallback / permissionPolicy: consumed by the driver
 *    resume + permission paths, not by thread/start.
 */
export function buildThreadStartParams(
  spec: HarnessInvocationSpec,
  driver: CodexAppServerDriverSpec
): Record<string, unknown> {
  return {
    model: driver.model ?? null,
    modelProvider: null,
    profile: driver.profile ?? null,
    cwd: spec.process.cwd,
    approvalPolicy: driver.approvalPolicy ?? 'never',
    sandbox: driver.sandboxMode ?? null,
    config:
      driver.modelReasoningEffort !== undefined
        ? { model_reasoning_effort: driver.modelReasoningEffort }
        : null,
    baseInstructions: null,
    developerInstructions: null,
    experimentalRawEvents: false,
  }
}

function extractThreadId(response: ThreadResponse | undefined): string {
  const threadId = response?.threadId ?? response?.thread?.id
  if (!threadId) {
    throw new BrokerError(
      BrokerErrorCode.HarnessError,
      'Codex thread id missing after app-server thread start'
    )
  }
  return threadId
}

function isMissingThreadError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) {
    return false
  }
  const code = extractErrorCode(error)
  return code === 'thread_missing' || /not found|no rollout found/i.test(error.message)
}

function extractErrorCode(error: CodexRpcError): string | undefined {
  if (typeof error.data === 'string') return error.data
  if (error.data !== null && typeof error.data === 'object') {
    const data = error.data as Record<string, unknown>
    return typeof data['code'] === 'string' ? data['code'] : undefined
  }
  return undefined
}
