import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { type TmuxExec, TmuxPaneController, type TmuxPaneControllerLease } from '../../runtime/tmux'
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
    /**
     * Default tmux server socket — IGNORED by the lease-consuming driver path
     * (Phase C, T-01725). Retained on the options shape only for backward
     * compatibility with construction sites that still pass it; the live
     * socket is ALWAYS `runtime.terminalSurface.socketPath` from the pane
     * lease handed in on start.
     */
    socketPath?: string | undefined
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
  hooks: {
    listen: (handler: HookEnvelopeHandler) => Promise<HookListenerHandle>
    /**
     * Executable that the in-pane Claude hook settings overlay invokes to POST
     * each hook payload to the broker callback socket. Broker-owned (H3); no
     * hrc-runtime dependency. Defaults to the broker's `claude-hook` subcommand.
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

  let ctx: DriverContext | undefined
  let surface: SurfaceState | undefined
  let hookListener: HookListenerHandle | undefined
  let hookDrain: Promise<void> = Promise.resolve()
  // The runtime hands the driver a pane LEASE — `runtime.terminalSurface`
  // (kind: 'tmux-pane', ownership: 'hrc', T-01723 Phase A). The driver
  // attaches to that lease through a TmuxPaneController (T-01724 Phase B)
  // and NEVER constructs or owns a tmux session/server. All capability gates
  // (inspect, sendInput, sendInterrupt, capture, resize) come from the
  // lease's `allowedOps` set.
  let paneController: TmuxPaneController | undefined
  // Active broker turn id (cody's Phase 3 seam, H2). Set by applyInputNow so
  // raw hook envelopes that carry neither an envelope turn id nor a raw
  // `turn_id` still attribute turn.started/turn.completed to the live turn.
  let activeTurnId: string | undefined
  let turnCounter = 0

  // Single shared per-invocation turn-id allocator (cody's blessed scheme,
  // C-02755). BOTH applyInputNow (manager path) and the hook normalizer (which
  // mints for turn-id-less operator prompts) call THIS closure so manager- and
  // normalizer-minted ids never collide and stay monotonic in turn-open order.
  function allocateTurnId(): string {
    turnCounter += 1
    return `turn_${requireCtx().invocationId}_${turnCounter}`
  }

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
    kind: CLAUDE_CODE_TMUX_DRIVER_KIND,
    version: CLAUDE_CODE_TMUX_DRIVER_VERSION,

    capabilities(): InvocationCapabilities {
      return CLAUDE_CODE_TMUX_CAPABILITIES
    },

    async start(spec: HarnessInvocationSpec, driverCtx: DriverContext): Promise<DriverStartResult> {
      // T-01725 Phase C: the driver consumes a pane LEASE supplied on the
      // dispatch envelope as `runtime.terminalSurface` (kind: 'tmux-pane',
      // ownership: 'hrc'). It reads ONLY this field — never the legacy
      // `runtime.tmux.socketPath` boundary shim — so capability scope is
      // explicit and the driver cannot fall through to a server it owns.
      const lease = driverCtx.runtime?.terminalSurface
      if (lease === undefined) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'claude-code-tmux start requires a runtime pane lease (runtime.terminalSurface); ' +
            'HRC / the pre-HRC harness owns the tmux server and must hand the driver a pane'
        )
      }
      if (lease.kind !== 'tmux-pane') {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `claude-code-tmux requires runtime.terminalSurface.kind === 'tmux-pane' (got ${String(
            (lease as { kind?: unknown }).kind
          )})`
        )
      }
      if (lease.ownership !== 'hrc') {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `claude-code-tmux requires runtime.terminalSurface.ownership === 'hrc' (got ${String(
            (lease as { ownership?: unknown }).ownership
          )})`
        )
      }

      ctx = driverCtx
      // Construct the pane controller against the leased pane on the
      // runtime-owned tmux server. The controller enforces allowedOps; it
      // ONLY issues capability-safe verbs (send-keys, paste-buffer, set-buffer,
      // capture-pane, display-message) and never any lifecycle command.
      const controllerLease: TmuxPaneControllerLease = {
        paneId: lease.paneId,
        sessionId: lease.sessionId,
        windowId: lease.windowId,
        ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
        ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
        allowedOps: lease.allowedOps,
      }
      paneController = new TmuxPaneController({
        socketPath: lease.socketPath,
        ...(options.tmux.tmuxBin !== undefined ? { tmuxBin: options.tmux.tmuxBin } : {}),
        ...(options.tmux.exec !== undefined ? { exec: options.tmux.exec } : {}),
        lease: controllerLease,
      })

      // Validate the leased pane exists and the tmux server's reported ids
      // match the lease (operator integrity check — fail loudly if HRC handed
      // us a stale or wrong pane).
      let inspection: { paneId: string; sessionId: string; windowId: string }
      try {
        inspection = await paneController.inspect()
      } catch (error) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `leased pane not found or id mismatch: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      if (
        inspection.paneId !== lease.paneId ||
        inspection.sessionId !== lease.sessionId ||
        inspection.windowId !== lease.windowId
      ) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `leased pane not found or id mismatch: tmux reported ${inspection.sessionId}/${inspection.windowId}/${inspection.paneId}, lease ${lease.sessionId}/${lease.windowId}/${lease.paneId}`
        )
      }

      surface = {
        socketPath: lease.socketPath,
        sessionId: lease.sessionId,
        windowId: lease.windowId,
        paneId: lease.paneId,
        ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
        ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
      }

      // Wire the hook ingestion callback socket → normalize via the ENVELOPE
      // turn id seam → re-emit as broker events through ctx.emit. The shared
      // stateful normalizer preserves activeTurnId / completed-turn dedup.
      const normalizer: ClaudeCodeHookEventNormalizer = createClaudeCodeHookEventNormalizer({
        invocationId: driverCtx.invocationId,
        now,
        allocateTurnId,
      })
      hookDrain = Promise.resolve()
      const handleHookEnvelope = async (envelope: ClaudeCodeHookEnvelope): Promise<void> => {
        // H2: when neither the envelope nor the raw hook carries a turn id, fall
        // back to the driver-tracked active broker turn id so turn lifecycle
        // events still resolve to the live turn. The fallback is only injected
        // while a turn is OPEN — it is cleared on terminal below so a stale,
        // already-completed id is never merged into raw turn_id indistinguishably
        // (C-02755 step 5); that lets the normalizer mint a fresh id for the next
        // turn-id-less operator prompt.
        const effectiveEnvelope =
          envelope.turnId === undefined && activeTurnId !== undefined
            ? { ...envelope, turnId: activeTurnId }
            : envelope
        for (const event of normalizeHookEnvelope(effectiveEnvelope, { normalizer })) {
          driverCtx.emit(event.type, event.payload, {
            ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
            ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
            ...(event.driver !== undefined ? { driver: event.driver } : {}),
          })
          // Provenance sync (C-02755 step 5): mirror the normalizer's turn
          // lifecycle into the driver-side fallback id. After turn.started, point
          // the fallback at the live turn (so its tool-call/Stop hooks resolve);
          // after a terminal, clear it so the next turn-id-less prompt mints.
          if (event.type === 'turn.started' && event.turnId !== undefined) {
            activeTurnId = event.turnId
          } else if (event.type === 'turn.completed') {
            if (activeTurnId === event.turnId) {
              activeTurnId = undefined
            }
          }
        }
      }
      hookListener = await options.hooks.listen((envelope) => {
        hookDrain = hookDrain.then(
          () => handleHookEnvelope(envelope),
          () => handleHookEnvelope(envelope)
        )
        return hookDrain
      })

      // T-01725 Q3: report-back. Echo the lease ids exactly so consumers can
      // confirm the lease the driver is operating from matches what HRC
      // handed out.
      driverCtx.emit(
        'terminal.surface.reported',
        {
          kind: 'tmux-pane' as const,
          socketPath: lease.socketPath,
          sessionId: lease.sessionId,
          windowId: lease.windowId,
          paneId: lease.paneId,
          ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
          ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
        },
        { driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'tmux.surface' } }
      )

      // Launch Claude inside the LEASED pane (stdio inherits the pty —
      // attachable). H1: the launch installs a broker-owned Claude hook
      // settings overlay so the REAL runtime posts UserPromptSubmit /
      // PreToolUse / PostToolUse / Stop… to the broker callback socket
      // OUT-OF-BAND (not via stdout). Env vars alone do not make Claude
      // invoke hooks.
      const launchCommand = await buildLaunchCommandLine(spec, {
        invocationId: driverCtx.invocationId,
        callbackSocket: hookListener.socketPath,
        bridgeCommand: options.hooks.bridgeCommand,
      })
      const launchScriptPath = await writeLaunchScript(hookListener.socketPath, launchCommand)
      await paneController.sendKeys(`exec /bin/sh ${shellQuote(launchScriptPath)}`)

      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      requireCtx()
      requireSurface()
      const text = extractText(input)
      // H2: open a broker-tracked turn so out-of-band hook envelopes that omit a
      // turn id are attributed to this turn. Uses the SAME shared allocator as
      // the normalizer (C-02755) and is returned to the caller as the
      // authoritative turn id for this input.
      const turnId = allocateTurnId()
      activeTurnId = turnId
      // terminal-literal-input turn delivery: literal text, a short TUI-friendly
      // pause, then Enter so shell expansion / key interpretation never mangles
      // the prompt and Claude reliably submits it.
      await requirePaneController().sendKeys(text)
      return { turnId: turnId as ApplyInputResult['turnId'] }
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (paneController === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      await paneController.interrupt()
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      // T-01725: the driver does NOT own the tmux session/server and so does
      // not kill anything during stop. Pane lifecycle (kill-session, server
      // teardown) belongs to HRC / the pre-HRC harness — the driver simply
      // releases its hook listener and drops the pane controller reference.
      await closeHookListener()
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      // T-01725: dispose releases driver-owned resources only — the hook
      // listener and the in-memory pane controller. tmux server / session
      // lifecycle stays with the runtime control plane.
      await closeHookListener()
      ctx = undefined
      surface = undefined
      paneController = undefined
      activeTurnId = undefined
    },
  }

  async function closeHookListener(): Promise<void> {
    await hookDrain.catch(() => undefined)
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

/** Claude Code hook events the broker overlay subscribes to. */
const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'MessageDisplay',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SubagentStop',
  'SessionEnd',
] as const

const DEFAULT_HOOK_BRIDGE_COMMAND = 'harness-broker claude-hook'

/**
 * Build the Claude Code `--settings` overlay (H1). Env vars alone do NOT make
 * Claude invoke hooks; the runtime needs an actual `hooks` settings block whose
 * commands POST each hook payload to the broker callback socket. The bridge
 * command reads the hook JSON on stdin and the `HARNESS_BROKER_*` env to build
 * the envelope, then writes it to the callback socket (broker-owned, H3).
 */
export function buildClaudeHookSettingsOverlay(options: {
  callbackSocket: string
  bridgeCommand?: string | undefined
}): { hooks: Record<string, unknown> } {
  const bridge = options.bridgeCommand ?? DEFAULT_HOOK_BRIDGE_COMMAND
  const command = `${bridge} --socket ${shellQuote(options.callbackSocket)}`
  const matchAll = ['PreToolUse', 'PostToolUse']
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENT_NAMES) {
    const entry: Record<string, unknown> = { hooks: [{ type: 'command', command }] }
    if (matchAll.includes(event)) {
      entry['matcher'] = '*'
    }
    hooks[event] = [entry]
  }
  return { hooks }
}

async function buildLaunchCommandLine(
  spec: HarnessInvocationSpec,
  hookEnv: { invocationId: string; callbackSocket: string; bridgeCommand?: string | undefined }
): Promise<string> {
  const assignments: string[] = [
    `HARNESS_BROKER_INVOCATION_ID=${shellQuote(hookEnv.invocationId)}`,
    `HARNESS_BROKER_CALLBACK_SOCKET=${shellQuote(hookEnv.callbackSocket)}`,
    `HARNESS_BROKER_HOOK_EVENTS=${shellQuote(HOOK_EVENT_NAMES.join(','))}`,
    'HARNESS_BROKER_HOOK_GENERATION=1',
  ]
  const launchArgs = await buildArgsWithMergedSettings(spec.process.args, hookEnv)
  const argv = [spec.process.command, ...launchArgs].map(shellQuote)
  return [...assignments, ...argv].join(' ')
}

async function writeLaunchScript(callbackSocket: string, commandLine: string): Promise<string> {
  const { chmod, mkdir, writeFile } = await import('node:fs/promises')
  const launchScriptPath = `${callbackSocket}.launch.sh`
  await mkdir(dirname(launchScriptPath), { recursive: true })
  await writeFile(launchScriptPath, `#!/bin/sh\n${commandLine}\n`, 'utf8')
  await chmod(launchScriptPath, 0o700)
  return launchScriptPath
}

async function buildArgsWithMergedSettings(
  args: string[],
  hookEnv: { callbackSocket: string; bridgeCommand?: string | undefined }
): Promise<string[]> {
  const separatorIndex = args.indexOf('--')
  const preSeparatorArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const postSeparatorArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex)
  const durableSettingsPaths: string[] = []
  const cleanedPreSeparatorArgs: string[] = []

  for (let i = 0; i < preSeparatorArgs.length; i += 1) {
    const arg = preSeparatorArgs[i]
    if (arg === undefined) continue
    if (arg === '--settings') {
      const settingsPath = preSeparatorArgs[i + 1]
      if (settingsPath !== undefined) {
        durableSettingsPaths.push(settingsPath)
        i += 1
      }
      continue
    }
    cleanedPreSeparatorArgs.push(arg)
  }

  const mergedSettingsPath = await writeMergedSettingsFile(durableSettingsPaths, hookEnv)
  return [...cleanedPreSeparatorArgs, '--settings', mergedSettingsPath, ...postSeparatorArgs]
}

async function writeMergedSettingsFile(
  durableSettingsPaths: string[],
  hookEnv: { callbackSocket: string; bridgeCommand?: string | undefined }
): Promise<string> {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const mergedSettings: Record<string, unknown> = {}
  for (const settingsPath of durableSettingsPaths) {
    const raw = await readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    Object.assign(mergedSettings, parsed)
  }
  Object.assign(
    mergedSettings,
    buildClaudeHookSettingsOverlay({
      callbackSocket: hookEnv.callbackSocket,
      bridgeCommand: hookEnv.bridgeCommand,
    })
  )

  const settingsPath = `${hookEnv.callbackSocket}.settings.json`
  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2), 'utf8')
  return settingsPath
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
 * this driver performs no I/O. T-01725: no default tmux socket — the live
 * pane lease (`runtime.terminalSurface`) supplies it on start.
 */
export function createDefaultClaudeCodeTmuxDriver(): Driver {
  const socketDir = join(tmpdir(), 'harness-broker')
  return createClaudeCodeTmuxDriver({
    tmux: {},
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
