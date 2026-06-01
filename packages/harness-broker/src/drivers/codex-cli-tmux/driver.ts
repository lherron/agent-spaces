import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { type TmuxExec, TmuxPaneController, type TmuxPaneControllerLease } from '../../runtime/tmux'
import { writeTmuxLaunchExecFiles } from '../../runtime/tmux-launch-exec'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import {
  CODEX_CLI_TMUX_DRIVER_KIND,
  type CodexCliTmuxHookEnvelope,
  type CodexCliTmuxHookEventNormalizer,
  createCodexCliTmuxHookEventNormalizer,
  normalizeCodexHookEnvelope,
} from './hook-events'
import { type CodexHookTranscriptReader, createCodexHookTranscriptReader } from './hook-transcript'

const CODEX_CLI_TMUX_DRIVER_VERSION = '0.1.0'

/**
 * Live hook generation stamped into the launch env (HARNESS_BROKER_HOOK_GENERATION)
 * and used to fence out-of-band hook envelopes against stale durable runtimes
 * (T-01794 Phase D).
 */
const CODEX_HOOK_GENERATION = 1

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
    // T-01794 Phase D: `attach` is OPERATOR `tmux attach`. It does NOT mean the
    // broker can restart this driver and reattach to an already-live surface;
    // that distinct capability is explicitly false (no impl in scope).
    driverAttachExistingSurface: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export interface CodexHookListenerHandle {
  socketPath: string
  close: () => Promise<void>
}

/**
 * Per-invocation/runtime identity handed to the hook listener so a durable
 * broker binds a UNIQUE callback socket per invocation under its runtime hooks
 * dir (T-01794 Phase D) — never the legacy single global codex-hooks.sock.
 */
export interface CodexHookListenerContext {
  invocationId: string
  runtimeId?: string | undefined
}

export type CodexHookEnvelopeHandler = (envelope: CodexCliTmuxHookEnvelope) => Promise<void>

export interface CodexCliTmuxDriverOptions {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  hooks: {
    listen: (
      handler: CodexHookEnvelopeHandler,
      context: CodexHookListenerContext
    ) => Promise<CodexHookListenerHandle>
    /**
     * Broker-owned receiver command invoked by the generated HRC_LAUNCH_HOOK_CLI
     * wrapper. Defaults to the installed `harness-broker codex-hook` CLI.
     */
    bridgeCommand?: string | undefined
  }
  now?: (() => Date) | undefined
}

interface SurfaceState {
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName?: string | undefined
  windowName?: string | undefined
}

type RuntimeTerminalSurface = TmuxPaneControllerLease & {
  kind?: unknown
  ownership?: unknown
  socketPath: string
}

export function createCodexCliTmuxDriver(options: CodexCliTmuxDriverOptions): Driver {
  const now = options.now ?? (() => new Date())

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let hookListener: CodexHookListenerHandle | undefined
  let transcriptReader: CodexHookTranscriptReader | undefined
  let hookDrain: Promise<void> = Promise.resolve()
  let currentTurnId: string | undefined
  let paneController: TmuxPaneController | undefined

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

  function requirePaneController(): TmuxPaneController {
    if (paneController === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'tmux surface not established')
    }
    return paneController
  }

  return {
    kind: CODEX_CLI_TMUX_DRIVER_KIND,
    version: CODEX_CLI_TMUX_DRIVER_VERSION,

    capabilities(): InvocationCapabilities {
      return CODEX_CLI_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      const runtime = driverCtx.runtime as
        | { terminalSurface?: RuntimeTerminalSurface | undefined }
        | undefined
      const leaseSurface = runtime?.terminalSurface
      if (
        leaseSurface === undefined ||
        leaseSurface.kind !== 'tmux-pane' ||
        leaseSurface.ownership !== 'hrc'
      ) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'codex-cli-tmux start requires runtime.terminalSurface to be an hrc-owned tmux-pane lease'
        )
      }

      const lease: TmuxPaneControllerLease = {
        sessionId: leaseSurface.sessionId,
        windowId: leaseSurface.windowId,
        paneId: leaseSurface.paneId,
        ...(leaseSurface.sessionName !== undefined
          ? { sessionName: leaseSurface.sessionName }
          : {}),
        ...(leaseSurface.windowName !== undefined ? { windowName: leaseSurface.windowName } : {}),
        allowedOps: leaseSurface.allowedOps,
      }
      const controller = new TmuxPaneController({
        socketPath: leaseSurface.socketPath,
        tmuxBin: options.tmux.tmuxBin,
        exec: options.tmux.exec,
        lease,
      })
      const inspection = await controller.inspect()
      if (
        inspection.sessionId !== lease.sessionId ||
        inspection.windowId !== lease.windowId ||
        inspection.paneId !== lease.paneId
      ) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `codex-cli-tmux leased pane identity mismatch: expected ${lease.sessionId}/${lease.windowId}/${lease.paneId}, observed ${inspection.sessionId}/${inspection.windowId}/${inspection.paneId}`
        )
      }

      ctx = driverCtx
      paneController = controller

      const expectedRuntimeId = getInvocationRuntimeId(spec)
      const normalizer: CodexCliTmuxHookEventNormalizer = createCodexCliTmuxHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
      })
      currentTurnId = undefined
      hookDrain = Promise.resolve()
      // Hook-driven rollout transcript reader (T-01710): reads newly appended
      // transcript bytes synchronously from hook processing — NO polling timer —
      // so interim agent prose is emitted in hook order, attributed to the live
      // turn, and the terminal message lands before turn.completed.
      const reader = createCodexHookTranscriptReader({
        invocationId: driverCtx.invocationId,
        now,
        getCurrentTurnId: () => currentTurnId,
      })
      transcriptReader = reader
      const emit = (event: InvocationEventEnvelope): void => {
        driverCtx.emit(event.type, event.payload, {
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
          ...(event.driver !== undefined ? { driver: event.driver } : {}),
        })
      }
      const handleHookEnvelope = (envelope: CodexCliTmuxHookEnvelope): void => {
        // T-01794 Phase D: durable identity fencing. Reject an envelope whose
        // invocation/runtime/generation/callback-socket does not match the live
        // invocation — but STRICTLY only for fields the durable unix mode
        // actually provides, so legacy/stdio rows that omit generation/runtimeId
        // are never rejected for an absent field.
        if (envelope.invocationId !== undefined && envelope.invocationId !== driverCtx.invocationId) {
          return
        }
        if (
          expectedRuntimeId !== undefined &&
          envelope.runtimeId !== undefined &&
          envelope.runtimeId !== expectedRuntimeId
        ) {
          return
        }
        if (envelope.generation !== undefined && envelope.generation !== CODEX_HOOK_GENERATION) {
          return
        }
        if (
          envelope.callbackSocket !== undefined &&
          hookListener !== undefined &&
          envelope.callbackSocket !== hookListener.socketPath
        ) {
          return
        }
        const hook = extractHookRecord(envelope)
        const envelopeTurnId = getHookString(hook, 'turn_id') ?? envelope.turnId
        if (envelopeTurnId !== undefined) {
          currentTurnId = envelopeTurnId
        }
        if (
          getHookString(hook, 'hook_event_name') === 'SessionStart' &&
          (getHookString(hook, 'transcript_path') ?? '').length === 0
        ) {
          emitTranscriptDiagnostic(driverCtx, undefined, undefined)
        }
        // Read the transcript BEFORE normalizing the triggering hook so interim
        // assistant messages land first and the terminal message precedes
        // turn.completed on Stop.
        for (const event of reader.handleHook(hook)) emit(event)
        for (const event of normalizeCodexHookEnvelope(envelope, { normalizer })) emit(event)
      }
      // Serialize hook processing like the Claude driver's hookDrain so transcript
      // reads and hook normalization stay strictly ordered.
      hookListener = await options.hooks.listen(
        (envelope) => {
          hookDrain = hookDrain.then(
            () => handleHookEnvelope(envelope),
            () => handleHookEnvelope(envelope)
          )
          return hookDrain
        },
        {
          invocationId: driverCtx.invocationId,
          ...(expectedRuntimeId !== undefined ? { runtimeId: expectedRuntimeId } : {}),
        }
      )

      surface = {
        socketPath: leaseSurface.socketPath,
        sessionId: lease.sessionId,
        windowId: lease.windowId,
        paneId: lease.paneId,
        ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
        ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
      }

      driverCtx.emit(
        'terminal.surface.reported',
        {
          kind: 'tmux-pane' as const,
          socketPath: surface.socketPath,
          sessionId: surface.sessionId,
          windowId: surface.windowId,
          paneId: surface.paneId,
          ...(surface.sessionName !== undefined ? { sessionName: surface.sessionName } : {}),
          ...(surface.windowName !== undefined ? { windowName: surface.windowName } : {}),
        },
        { driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      const hookCliPath = await writeCodexHookBridgeWrapper({
        callbackSocket: hookListener.socketPath,
        bridgeCommand: options.hooks.bridgeCommand,
      })
      // Shell-readiness is handled deterministically inside sendPastedLine: it
      // (re)pastes until the command renders at the prompt, so a paste dropped
      // before the leased pane's shell PTY is reading is retried rather than lost.
      // No blind pre-paste sleep (T-01747) — that masked the race and cost ~1.5s
      // every launch; a dropped paste used to fall through to a 10s timeout +
      // bare-shell pane.
      await controller.sendPastedLine(
        await buildLaunchCommandLine(spec, driverCtx, {
          callbackSocket: hookListener.socketPath,
          hookCliPath,
        })
      )
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      requireCtx()
      requireSurface()
      const controller = requirePaneController()
      await controller.sendLiteral(extractText(input))
      await sleep(1_000)
      await controller.sendEnter()
      return {}
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (surface === undefined || paneController === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      await paneController.interrupt()
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      await terminateSession()
      resetTranscriptReader()
      await closeHookListener()
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await terminateSession()
      resetTranscriptReader()
      await closeHookListener()
      ctx = undefined
      surface = undefined
      currentTurnId = undefined
      paneController = undefined
    },
  }

  async function terminateSession(): Promise<void> {
    surface = undefined
  }

  async function closeHookListener(): Promise<void> {
    await hookDrain.catch(() => undefined)
    if (hookListener !== undefined) {
      const handle = hookListener
      hookListener = undefined
      await handle.close()
    }
  }

  function resetTranscriptReader(): void {
    transcriptReader?.reset()
    transcriptReader = undefined
  }
}

function emitTranscriptDiagnostic(
  ctx: DriverContext,
  transcriptPath: string | undefined,
  error: unknown
): void {
  ctx.emit(
    'diagnostic',
    {
      level: 'warn',
      source: 'driver',
      message:
        'Codex SessionStart did not provide a usable transcript_path; relying on Stop finalOutput',
      data: {
        ...(transcriptPath !== undefined ? { transcriptPath } : {}),
        ...(error !== undefined
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      },
    },
    { driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'SessionStart' } }
  )
}

function getInvocationRuntimeId(spec: HarnessInvocationSpec): string | undefined {
  return spec.correlation?.['runtimeId']
}

function extractHookRecord(envelope: CodexCliTmuxHookEnvelope): Record<string, unknown> {
  const hook = asRecord(envelope.hookData ?? envelope.hookEvent ?? envelope.payload ?? envelope)
  const nested = asRecord(hook['hookEvent'])
  return nested['hook_event_name'] !== undefined ? nested : hook
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function getHookString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

async function buildLaunchCommandLine(
  spec: HarnessInvocationSpec,
  ctx: DriverContext,
  hookEnv: { callbackSocket: string; hookCliPath: string }
): Promise<string> {
  const env = {
    ...spec.process.lockedEnv,
    ...(ctx.dispatchEnv ?? {}),
    HRC_LAUNCH_HOOK_CLI: hookEnv.hookCliPath,
    HARNESS_BROKER_INVOCATION_ID: ctx.invocationId,
    HARNESS_BROKER_CALLBACK_SOCKET: hookEnv.callbackSocket,
    HARNESS_BROKER_HOOK_GENERATION: String(CODEX_HOOK_GENERATION),
  }
  const launch = await writeTmuxLaunchExecFiles(`${hookEnv.callbackSocket}.codex`, {
    argv: [spec.process.command, ...spec.process.args],
    cwd: spec.process.cwd,
    env,
    ...(spec.launch !== undefined ? { prompts: spec.launch } : {}),
  })
  return launch.commandLine
}

const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker codex-hook'

async function writeCodexHookBridgeWrapper(options: {
  callbackSocket: string
  bridgeCommand?: string | undefined
}): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND
  const wrapperPath = `${options.callbackSocket}.codex-hook.ts`
  const shellCommand = `${bridge} --socket ${shellQuote(options.callbackSocket)}`
  await mkdir(dirname(wrapperPath), { recursive: true })
  await writeFile(
    wrapperPath,
    [
      '#!/usr/bin/env bun',
      "import { spawn } from 'node:child_process'",
      '',
      `const child = spawn('/bin/sh', ['-lc', ${JSON.stringify(`exec ${shellCommand}`)}], {`,
      "  stdio: 'inherit',",
      '  env: process.env,',
      '})',
      "child.on('error', (error) => {",
      '  process.stderr.write(`codex-hook wrapper failed: ${error instanceof Error ? error.message : String(error)}\\n`)',
      '  process.exit(0)',
      '})',
      "child.on('exit', (code, signal) => {",
      '  if (signal) process.kill(process.pid, signal)',
      '  else process.exit(code ?? 0)',
      '})',
      '',
    ].join('\n'),
    'utf8'
  )
  return wrapperPath
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createDefaultCodexCliTmuxDriver(
  socketDir: string = join(tmpdir(), 'harness-broker')
): Driver {
  return createCodexCliTmuxDriver({
    tmux: { socketPath: join(socketDir, 'codex-tmux.sock') },
    hooks: {
      // T-01794 Phase D: per-invocation/runtime hook socket under the runtime
      // hooks dir — kills the single global /tmp/harness-broker/codex-hooks.sock
      // that two durable broker runtimes would otherwise collide on.
      listen: (handler, context) =>
        listenForHookEnvelopes(buildCodexHookSocketPath(socketDir, context), handler),
    },
  })
}

/**
 * Build a SHORT, per-invocation/runtime codex hook socket path under
 * `socketDir`. Mirrors `buildClaudeHookSocketPath`: a 16-hex digest of
 * invocationId+runtimeId keeps the basename short so the relocated socket and
 * its derived wrapper/launch-artifact paths stay within the unix socket path
 * budget (Phase B).
 */
export function buildCodexHookSocketPath(
  socketDir: string,
  context: CodexHookListenerContext
): string {
  const token = createHash('sha256')
    .update(`${context.invocationId}\0${context.runtimeId ?? ''}`)
    .digest('hex')
    .slice(0, 16)
  return join(socketDir, `codex-hooks.${token}.sock`)
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
