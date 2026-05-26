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
  CLAUDE_CODE_TMUX_DRIVER_KIND,
  type ClaudeCodeHookEnvelope,
  type ClaudeCodeHookEventNormalizer,
  createClaudeCodeHookEventNormalizer,
  normalizeHookEnvelope,
} from './hook-events'

const CLAUDE_CODE_TMUX_DRIVER_VERSION = '0.1.0'

const CLAUDE_CODE_TMUX_CAPABILITIES: InvocationCapabilities = {
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
    supported: false,
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

/** Handle returned by a hook callback listener bound to the broker socket. */
export interface HookListenerHandle {
  socketPath: string
  close: () => Promise<void>
}

/** Receives normalized hook envelopes posted by the in-pane Claude hook CLI. */
export type HookEnvelopeHandler = (envelope: ClaudeCodeHookEnvelope) => Promise<void>

export interface ClaudeCodeTmuxDriverOptions {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  hooks: {
    listen: (handler: HookEnvelopeHandler) => Promise<HookListenerHandle>
  }
  now?: (() => Date) | undefined
}

interface SurfaceState {
  socketPath: string
  sessionName: string
  paneId: string
}

/**
 * Phase 3 broker driver: launches an OPERATOR-ATTACHABLE interactive Claude
 * Code in a tmux session (pty transport, terminal host = tmux), delivers turns
 * via send-keys, normalizes the out-of-band Claude hook stream into broker
 * events, and reports the runtime tmux attach surface.
 *
 * AD-008: NO live reattach / NO event replay / NO claim HRC can recover a broker
 * invocation after restart — operator attach is plain `tmux attach`.
 */
export function createClaudeCodeTmuxDriver(options: ClaudeCodeTmuxDriverOptions): Driver {
  const now = options.now ?? (() => new Date())
  const tmux = new TmuxManager(options.tmux.socketPath, options.tmux.tmuxBin, options.tmux.exec)

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let hookListener: HookListenerHandle | undefined

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

  return {
    kind: CLAUDE_CODE_TMUX_DRIVER_KIND,
    version: CLAUDE_CODE_TMUX_DRIVER_VERSION,

    capabilities(): InvocationCapabilities {
      return CLAUDE_CODE_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      ctx = driverCtx
      await tmux.initialize()

      // Wire the hook ingestion callback socket → normalize via the ENVELOPE
      // turn id seam → re-emit as broker events through ctx.emit.
      const normalizer: ClaudeCodeHookEventNormalizer = createClaudeCodeHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
      })
      hookListener = await options.hooks.listen(async (envelope) => {
        for (const event of normalizeHookEnvelope(envelope, { normalizer })) {
          driverCtx.emit(event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
        }
      })

      // Create / reuse the attachable tmux session. Session/pane ids are
      // RUNTIME-REPORTED by tmux (guardrail #6), not pre-allocated.
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
        { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      // Launch Claude inside the pane (stdio inherits the pty — attachable).
      // Hooks arrive OUT-OF-BAND via the callback socket, not via stdout.
      const launchCommand = buildLaunchCommandLine(spec, {
        invocationId: driverCtx.invocationId,
        callbackSocket: hookListener.socketPath,
      })
      await tmux.sendKeys(pane.paneId, launchCommand)

      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      requireCtx()
      const { paneId } = requireSurface()
      const text = extractText(input)
      // terminal-literal-input turn delivery: literal text then Enter so shell
      // expansion / key interpretation never mangles the prompt.
      await tmux.sendLiteral(paneId, text)
      await tmux.sendEnter(paneId)
      return {}
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      const current = surface
      if (current === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      await tmux.interrupt(current.paneId)
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      const current = surface
      if (current !== undefined) {
        await tmux.terminate(current.sessionName)
      }
      await closeHookListener()
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await closeHookListener()
      ctx = undefined
      surface = undefined
    },
  }

  async function closeHookListener(): Promise<void> {
    if (hookListener !== undefined) {
      const handle = hookListener
      hookListener = undefined
      await handle.close()
    }
  }
}

function extractText(input: InvocationInput): string {
  return input.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((segment) => segment.length > 0)
    .join('')
}

function buildLaunchCommandLine(
  spec: HarnessInvocationSpec,
  hookEnv: { invocationId: string; callbackSocket: string }
): string {
  const assignments: string[] = [
    `HARNESS_BROKER_INVOCATION_ID=${shellQuote(hookEnv.invocationId)}`,
    `HARNESS_BROKER_CALLBACK_SOCKET=${shellQuote(hookEnv.callbackSocket)}`,
    'HARNESS_BROKER_HOOK_GENERATION=1',
  ]
  const argv = [spec.process.command, ...spec.process.args].map(shellQuote)
  return [...assignments, ...argv].join(' ')
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Default-configured driver for registry registration. Uses the real tmux
 * binary and a real Unix-domain hook callback socket. The socket is bound
 * lazily inside `start()` (construction is side-effect-free), so registering
 * this driver performs no I/O.
 */
export function createDefaultClaudeCodeTmuxDriver(): Driver {
  const socketDir = join(tmpdir(), 'harness-broker')
  return createClaudeCodeTmuxDriver({
    tmux: { socketPath: join(socketDir, 'claude-tmux.sock') },
    hooks: {
      listen: (handler) => listenForHookEnvelopes(join(socketDir, 'claude-hooks.sock'), handler),
    },
  })
}

async function listenForHookEnvelopes(
  socketPath: string,
  handler: HookEnvelopeHandler
): Promise<HookListenerHandle> {
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
            await handler(JSON.parse(body) as ClaudeCodeHookEnvelope)
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
