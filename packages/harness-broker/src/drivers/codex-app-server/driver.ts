import { createInterface } from 'node:readline'
import type {
  CodexAppServerDriverSpec,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { spawnHarnessProcess } from '../../runtime/process-runner'
import { terminateProcess } from '../../runtime/signals'
import type { Driver, DriverContext, DriverStartResult } from '../driver'
import { mapCodexNotification, parseCodexError } from './event-map'
import { buildTurnStartParams } from './input'
import { handlePermissionRequest } from './permissions'
import { CodexRpcClient, CodexRpcError, type JsonRpcNotification } from './rpc-client'

const bunRuntime = typeof Bun !== 'undefined' ? (Bun as unknown as { execPath?: string }) : undefined
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
    queue: false,
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
  let currentInputId: string | undefined
  let currentTurnId: string | undefined
  let turnActive = false
  let startedEmitted = false
  let terminalEmitted = false
  let stopping = false
  let starting = false
  let rejectStartup: ((error: Error) => void) | undefined
  let startupFailure: Promise<never> | undefined

  function requireCtx(): DriverContext {
    if (!ctx) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function emitDiagnostic(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
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
      emitDiagnostic('error', error.message, error.code !== undefined ? { code: error.code } : error.data)
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

    for (const mapped of mapCodexNotification(notification)) {
      const extra =
        mapped.type === 'turn.started' ||
        mapped.type === 'turn.completed' ||
        mapped.type === 'turn.failed' ||
        mapped.type === 'turn.interrupted'
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

    async start(startSpec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      if (startSpec.driver.kind !== 'codex-app-server') {
        throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid Codex driver spec')
      }

      ctx = driverCtx
      spec = startSpec
      driverSpec = startSpec.driver as CodexAppServerDriverSpec
      terminalEmitted = false
      startedEmitted = false
      stopping = false
      starting = true
      startupFailure = new Promise<never>((_resolve, reject) => {
        rejectStartup = reject
      })

      proc = await spawnHarnessProcess(startSpec.process)
      proc.on('exit', onExit)
      createInterface({ input: proc.stderr }).on('line', (line) => {
        if (line.trim().length > 0) {
          emitDiagnostic('info', line)
        }
      })

      rpc = new CodexRpcClient(proc, {
        onNotification,
        onRequest: async (request) => handlePermissionRequest(request, driverSpec!),
        onError: (error) => {
          if (starting) {
            rejectStartup?.(error)
          }
        },
      })

      await withStartupRace(rpc.sendRequest('initialize', { clientInfo: { name: 'harness-broker', version: '0.1.0' } }))
      await withStartupRace(rpc.sendNotification('initialized', {}))
      threadId = await withStartupRace(startThread())

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

    async input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
      if (!rpc || !spec || !driverSpec || !threadId) {
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready')
      }

      const inputId = req.input.inputId ?? `input_${Date.now().toString(36)}`
      if (req.input.kind !== 'user') {
        const reason =
          req.input.kind === 'steer'
            ? 'UnsupportedCapability: input.steer'
            : 'UnsupportedCapability: input.appendContext'
        requireCtx().emit('input.rejected', { inputId, reason }, { inputId })
        throw new BrokerError(BrokerErrorCode.UnsupportedCapability, reason)
      }
      if (turnActive) {
        const reason = 'InputRejected: turn already active'
        requireCtx().emit('input.rejected', { inputId, reason }, { inputId })
        throw new BrokerError(BrokerErrorCode.InputRejected, reason)
      }

      currentInputId = inputId
      requireCtx().emit('input.accepted', { inputId }, { inputId })
      try {
        await rpc.sendRequest('turn/start', buildTurnStartParams({
          threadId,
          cwd: spec.process.cwd,
          input: req.input,
          driver: driverSpec,
        }))
      } catch (error) {
        if (terminalEmitted || turnActive) {
          return { inputId, accepted: true, disposition: 'started', ...(currentTurnId ? { turnId: currentTurnId } : {}) }
        }
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          error instanceof Error ? error.message : 'Codex turn failed to start'
        )
      }

      return { inputId, accepted: true, disposition: 'started', ...(currentTurnId ? { turnId: currentTurnId } : {}) }
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (req.scope === 'turn') {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: 'Codex app-server v0 does not support turn interrupt',
        }
      }
      return { accepted: false, effect: 'unsupported', reason: 'Codex app-server v0 interrupt unsupported' }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      stopping = true
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
    return Promise.race([work, startupFailure])
  }
}

function buildThreadStartParams(
  spec: HarnessInvocationSpec,
  driver: CodexAppServerDriverSpec
): Record<string, unknown> {
  return {
    model: driver.model ?? null,
    modelProvider: null,
    cwd: spec.process.cwd,
    approvalPolicy: driver.approvalPolicy ?? 'never',
    sandbox: driver.sandboxMode ?? null,
    config: null,
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
