import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { InvocationRuntimeContext } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { type HrcptyEvent, HrcptyPtyController, HrcptyRpcError } from '../../runtime/hrcpty'
import { buildTmuxLaunchArtifactEnv } from '../../runtime/tmux-launch-exec'
import type { ChildProcessInvocationSpec, DriverContext } from '../driver'
import { buildCodexTuiWrapperArgvPrefix } from './codex-tui-wrapper'
import type { CodexDriverEvents } from './driver-events'
import type { CodexAppServerDriverOptions, CodexDriverState } from './driver-state'

export type HrcptyLease = Extract<
  NonNullable<InvocationRuntimeContext['terminalSurface']>,
  { kind: 'hrcpty' }
>

/** The hrc-owned hrcpty lease this dispatch carries, if any (the seam `claude-code-hrcpty` keys on). */
export function hrcptyLeaseOf(ctx: DriverContext): HrcptyLease | undefined {
  const lease = ctx.runtime?.terminalSurface
  return lease?.kind === 'hrcpty' && lease.ownership === 'hrc' ? lease : undefined
}

/**
 * codex-hrcpty seat bring-up (T-12162 §4.1, §4.2 steps 1-3). The broker owns
 * the app-server: it spawns `codex app-server --listen unix://…` in its own
 * process group with the hook env, so hrc-pty's group signal on any broker
 * exit takes the app-server with it. hrc-pty starts with no child; the stock
 * remote TUI is spawned on its pty only when a read-write client attaches, so
 * the TUI's terminal queries reach the person's real terminal.
 */
export async function startCodexHrcptySeat(input: {
  s: CodexDriverState
  options: CodexAppServerDriverOptions
  events: CodexDriverEvents
  ctx: DriverContext
  spec: ChildProcessInvocationSpec
  lease: HrcptyLease
  websocketPath: string
  attachTokenPath: string
  controlSocketPath: string
  runtimeId: string | undefined
  /** The hook env the tmux route gives the wrapper; here it belongs on the app-server. */
  hookEnv: Record<string, string>
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}): Promise<void> {
  const { s, options, events, ctx, spec, lease } = input
  const { emitDiagnostic } = events
  const controller = new HrcptyPtyController({
    socketPath: lease.socketPath,
    allowedOps: lease.allowedOps,
    ...(options.hrcpty?.token !== undefined ? { token: options.hrcpty.token } : {}),
    ...(options.hrcpty?.connect !== undefined ? { connect: options.hrcpty.connect } : {}),
  })
  let hello: Awaited<ReturnType<HrcptyPtyController['hello']>>
  try {
    hello = await controller.hello()
  } catch (error) {
    controller.close()
    throw new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      `leased hrcpty supervisor unreachable at ${lease.socketPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  s.hrcpty = controller
  s.tuiPid = hello.child.state === 'running' ? (hello.child.pid ?? undefined) : undefined
  s.tuiSpawning = false

  await rm(input.websocketPath, { force: true }).catch(() => undefined)
  await rm(input.attachTokenPath, { force: true }).catch(() => undefined)
  // The env the tmux route's wrapper hands its app-server: lockedEnv,
  // dispatchEnv and the hook env over the runner's complete-environment base.
  const proc = spawn(
    spec.process.command,
    ['app-server', '--listen', `unix://${input.websocketPath}`],
    {
      cwd: spec.process.cwd,
      env: buildTmuxLaunchArtifactEnv(
        { ...spec.process.lockedEnv, ...(ctx.dispatchEnv ?? {}), ...input.hookEnv },
        spec.process.pathPrepend
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  // The websocket is the transport; nothing is written to or read from stdio.
  proc.stdin.end()
  proc.stdout.resume()
  s.proc = proc
  proc.on('exit', input.onExit)
  createInterface({ input: proc.stderr }).on('line', (line) => {
    if (line.trim().length > 0) emitDiagnostic('info', line)
  })

  const tuiArgv = [
    ...buildCodexTuiWrapperArgvPrefix(options.codexTuiLauncher),
    '--attach-only',
    '--command',
    spec.process.command,
    '--socket',
    input.websocketPath,
    '--attach-token',
    input.attachTokenPath,
    '--control-socket',
    input.controlSocketPath,
    '--invocation-id',
    ctx.invocationId,
    ...(input.runtimeId !== undefined ? ['--runtime-id', input.runtimeId] : []),
  ]
  const tuiEnv = buildTmuxLaunchArtifactEnv(
    { ...spec.process.lockedEnv, ...(ctx.dispatchEnv ?? {}) },
    spec.process.pathPrepend
  )

  // Step 2: spawn on a read-write attach when no TUI is alive. No cols/rows:
  // hrc-pty applied the attaching client's size before replay.
  async function spawnTuiForAttach(): Promise<void> {
    if (s.tuiPid !== undefined || s.tuiSpawning || s.stopping || s.terminalEmitted) return
    s.tuiSpawning = true
    try {
      const spawned = await controller.spawn({ argv: tuiArgv, env: tuiEnv, cwd: spec.process.cwd })
      s.tuiPid = spawned.pid
      emitDiagnostic('info', 'Codex TUI spawned for a read-write attach', {
        pid: spawned.pid,
        cols: spawned.cols,
        rows: spawned.rows,
      })
    } catch (error) {
      // A racing second attach finds the first one's TUI (§7).
      if (error instanceof HrcptyRpcError && error.code === 'child_alive') return
      emitDiagnostic('error', 'Codex TUI spawn failed', {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof HrcptyRpcError ? { code: error.code } : {}),
      })
    } finally {
      s.tuiSpawning = false
    }
  }

  function onEvent(event: HrcptyEvent): void {
    if (event.method === 'client.attached') {
      if (event.params['readOnly'] === false) void spawnTuiForAttach()
      return
    }
    if (event.method === 'child.exited') {
      const pid = event.params['pid']
      if (s.tuiPid === undefined || pid === s.tuiPid) s.tuiPid = undefined
    }
  }

  s.hrcptyEvents = await controller.subscribeEvents(onEvent, () => {
    if (s.stopping || s.terminalEmitted) return
    emitDiagnostic('warn', 'hrc-pty events subscription closed; TUI spawn on attach is off', {
      socketPath: lease.socketPath,
    })
  })
  // A client that attached before the subscription existed sent no event.
  const status = await controller.status()
  const clients = status['clients'] as { readWrite?: unknown } | undefined
  if (typeof clients?.readWrite === 'number' && clients.readWrite > 0) {
    await spawnTuiForAttach()
  }

  ctx.emit(
    'terminal.surface.reported',
    { kind: 'hrcpty-socket' as const, socketPath: lease.socketPath },
    { driver: { kind: 'codex-app-server', rawType: 'hrcpty.surface' } }
  )
}

/** Stop path (§5): signal a live TUI through the supervisor, then end the app-server. */
export async function stopCodexHrcptyTui(s: CodexDriverState): Promise<void> {
  s.hrcptyEvents?.close()
  s.hrcptyEvents = undefined
  if (s.tuiPid !== undefined) {
    await s.hrcpty?.signal('TERM').catch(() => undefined)
  }
  s.hrcpty?.close()
}
