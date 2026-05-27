import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { type TmuxExec, TmuxManager } from '../../runtime/tmux'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import {
  CODEX_CLI_TMUX_DRIVER_KIND,
  type CodexCliTmuxHookEnvelope,
  type CodexCliTmuxHookEventNormalizer,
  createCodexCliTmuxHookEventNormalizer,
  normalizeCodexHookEnvelope,
} from './hook-events'

const CODEX_CLI_TMUX_DRIVER_VERSION = '0.1.0'

const CODEX_CLI_TMUX_CAPABILITIES: InvocationCapabilities = {
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: false,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'process',
  },
  continuation: {
    supported: true,
  },
  events: {
    assistantDeltas: false,
    toolCalls: true,
    usage: false,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
  },
}

export interface CodexHookListenerHandle {
  socketPath: string
  close: () => Promise<void>
}

export type CodexHookEnvelopeHandler = (envelope: CodexCliTmuxHookEnvelope) => Promise<void>

export interface CodexCliTmuxDriverOptions {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  hooks: {
    listen: (handler: CodexHookEnvelopeHandler) => Promise<CodexHookListenerHandle>
  }
  now?: (() => Date) | undefined
}

interface SurfaceState {
  socketPath: string
  sessionName: string
  paneId: string
}

export function createCodexCliTmuxDriver(options: CodexCliTmuxDriverOptions): Driver {
  const now = options.now ?? (() => new Date())

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let hookListener: CodexHookListenerHandle | undefined
  let tmux: TmuxManager | undefined

  function requireCtx(): DriverContext {
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver has not started')
    }
    return ctx
  }

  function requireSurface(): SurfaceState {
    if (surface === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established')
    }
    return surface
  }

  function requireTmux(): TmuxManager {
    if (tmux === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established')
    }
    return tmux
  }

  return {
    kind: CODEX_CLI_TMUX_DRIVER_KIND,
    version: CODEX_CLI_TMUX_DRIVER_VERSION,

    capabilities(): InvocationCapabilities {
      return CODEX_CLI_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      const runtimeSocket = driverCtx.runtime?.tmux?.socketPath
      if (runtimeSocket === undefined || runtimeSocket.length === 0) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'codex-cli-tmux start requires a runtime tmux socket (runtime.tmux.socketPath)'
        )
      }

      ctx = driverCtx
      tmux = new TmuxManager(runtimeSocket, options.tmux.tmuxBin, options.tmux.exec)

      const normalizer: CodexCliTmuxHookEventNormalizer = createCodexCliTmuxHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
      })
      hookListener = await options.hooks.listen(async (envelope) => {
        for (const event of normalizeCodexHookEnvelope(envelope, { normalizer })) {
          driverCtx.emit(event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
        }
      })

      const hostSessionId =
        spec.correlation?.['hostSessionId'] ?? spec.invocationId ?? driverCtx.invocationId
      const pane = await tmux.ensurePane(hostSessionId, 'reuse_pty')
      surface = {
        socketPath: pane.socketPath,
        sessionName: pane.sessionName,
        paneId: pane.paneId,
      }

      driverCtx.emit(
        'terminal.surface.reported',
        {
          kind: 'tmux-session' as const,
          socketPath: pane.socketPath,
          sessionName: pane.sessionName,
          paneId: pane.paneId,
        },
        { driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      await tmux.sendKeys(pane.paneId, buildLaunchCommandLine(spec, driverCtx))
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      requireCtx()
      const { paneId } = requireSurface()
      await requireTmux().sendLiteral(paneId, extractText(input))
      await requireTmux().sendEnter(paneId)
      return {}
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      const current = surface
      if (current === undefined || tmux === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      await tmux.interrupt(current.paneId)
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      await terminateSession()
      await closeHookListener()
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await terminateSession()
      await closeHookListener()
      ctx = undefined
      surface = undefined
      tmux = undefined
    },
  }

  async function terminateSession(): Promise<void> {
    const current = surface
    if (current !== undefined && tmux !== undefined) {
      await tmux.terminate(current.sessionName)
    }
  }

  async function closeHookListener(): Promise<void> {
    if (hookListener !== undefined) {
      const handle = hookListener
      hookListener = undefined
      await handle.close()
    }
  }
}

function buildLaunchCommandLine(spec: HarnessInvocationSpec, ctx: DriverContext): string {
  const env = { ...spec.process.lockedEnv, ...(ctx.dispatchEnv ?? {}) }
  const assignments = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
  const argv = [spec.process.command, ...spec.process.args].map(shellQuote)
  return [...assignments, ...argv].join(' ')
}

function extractText(input: InvocationInput): string {
  return input.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((segment) => segment.length > 0)
    .join('')
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function createDefaultCodexCliTmuxDriver(): Driver {
  const socketDir = join(tmpdir(), 'harness-broker')
  return createCodexCliTmuxDriver({
    tmux: { socketPath: join(socketDir, 'codex-tmux.sock') },
    hooks: {
      listen: (handler) => listenForHookEnvelopes(join(socketDir, 'codex-hooks.sock'), handler),
    },
  })
}

async function listenForHookEnvelopes(
  socketPath: string,
  handler: CodexHookEnvelopeHandler
): Promise<CodexHookListenerHandle> {
  const { createServer } = await import('node:net')
  const { mkdir, rm } = await import('node:fs/promises')
  const { dirname } = await import('node:path')

  await mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined)
  await rm(socketPath, { force: true }).catch(() => undefined)

  const server = createServer((conn) => {
    const chunks: Buffer[] = []
    conn.on('data', (chunk: Buffer) => chunks.push(chunk))
    conn.on('end', () => {
      void (async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8').trim()
          if (body.length > 0) {
            await handler(JSON.parse(body) as CodexCliTmuxHookEnvelope)
          }
          conn.end('ok')
        } catch {
          conn.end('err')
        }
      })()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
