import { expect } from 'bun:test'
import type { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventFor,
  InvocationEventType,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationStopRequest,
} from 'spaces-harness-broker-protocol'
import type { Driver, DriverContext } from '../../../src/drivers/driver'
import { invocationIdFrom } from '../../ids'

export type TmuxExecCall = {
  argv: string[]
  env?: Record<string, string | undefined> | undefined
  loadedText?: string | undefined
}

export type HookEnvelope = {
  invocationId: string
  generation: number
  callbackSocket: string
  runtimeId?: string | undefined
  turnId?: string | undefined
  hookData: unknown
}

type LaunchArtifact = {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined> | undefined
}

type PaneLease = {
  kind: 'tmux-pane'
  ownership: 'hrc'
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName?: string | undefined
  windowName?: string | undefined
  allowedOps: {
    inspect: true
    sendInput: true
    sendInterrupt: true
    capture?: boolean | undefined
    resize?: boolean | undefined
  }
}

type BrokerRuntimeContext = {
  terminalSurface?: PaneLease | undefined
}

type ClaudeCodeTmuxDriverFactory = (options: {
  tmux: {
    socketPath?: string | undefined
    tmuxBin?: string | undefined
    exec: (
      argv: string[],
      options?: { env?: Record<string, string | undefined> | undefined }
    ) => Promise<{ stdout: string; stderr: string }>
  }
  hooks: {
    listen: (
      handler: (
        envelope: HookEnvelope
      ) => Promise<{ socketPath: string; close: () => Promise<void> } | void>
    ) => Promise<{
      socketPath: string
      close: () => Promise<void>
    }>
  }
  now: () => Date
  watchTranscript?:
    | ((
        path: string,
        options: { persistent: false },
        listener: () => void
      ) => EventEmitter & { close: () => void })
    | undefined
}) => {
  kind: string
  capabilities: Driver['capabilities']
  start: (spec: HarnessInvocationSpec, ctx: DriverContext) => Promise<{ ok: true }>
  applyInputNow: (input: InvocationInput) => Promise<{ turnId?: string | undefined }>
  admissionRejectionReason: (admissionClass: string) => string | undefined
  runtimeHealth: () => { state: 'healthy' } | { state: 'degraded'; reason: string }
  interrupt: (req: InvocationInterruptRequest) => Promise<{
    accepted: boolean
    effect: string
    reason?: string | undefined
  }>
  stop: (req: InvocationStopRequest) => Promise<{ accepted: boolean; state: string }>
  dispose: () => Promise<void>
}

export type HookListenerMeta = {
  invocationId: string
  runtimeId?: string | undefined
}

export const now = () => new Date('2026-05-26T15:30:00.000Z')

const tempHookDirs: string[] = []

/**
 * A hook callback socket path inside a fresh mkdtemp dir. The driver writes
 * `<socket>.claude.launch.json` and `<socket>.settings.json` beside the path a
 * fake `hooks.listen` returns, so a fixed path would leak them into a shared
 * directory. A file that uses it removes the dirs with
 * `afterEach(removeTempHookDirs)` (bun test fires no process exit hook).
 */
export function tempHookSocketPath(basename = 'claude-hooks.sock'): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-tmux-hooks-'))
  tempHookDirs.push(dir)
  return join(dir, basename)
}

export function removeTempHookDirs(): void {
  for (const dir of tempHookDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export const DEFAULT_LEASE_SOCKET = '/tmp/preallocated/hrc-owned-tmux.sock'
export const DEFAULT_LEASE_PANE = '%7'
export const DEFAULT_LEASE_SESSION = '$1'
export const DEFAULT_LEASE_WINDOW = '@1'
export const DEFAULT_LEASE_SESSION_NAME = 'hrc-host-sessio'

const FORBIDDEN_TMUX_VERBS = [
  'new-session',
  'kill-session',
  'start-server',
  'kill-server',
  'new-window',
  'split-window',
  'rename-session',
  'attach-session',
  'respawn-pane',
  'set-environment',
] as const

export function defaultLease(): PaneLease {
  return {
    kind: 'tmux-pane',
    ownership: 'hrc',
    socketPath: DEFAULT_LEASE_SOCKET,
    sessionId: DEFAULT_LEASE_SESSION,
    windowId: DEFAULT_LEASE_WINDOW,
    paneId: DEFAULT_LEASE_PANE,
    sessionName: DEFAULT_LEASE_SESSION_NAME,
    allowedOps: {
      inspect: true,
      sendInput: true,
      sendInterrupt: true,
      capture: true,
    },
  }
}

export const claudeTmuxSpec = (): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom('inv_claude_tmux_1'),
  harness: {
    frontend: 'claude-code',
    provider: 'anthropic',
    driver: 'claude-code-tmux',
  },
  process: {
    command: '/opt/bin/claude',
    args: ['--model', 'sonnet'],
    cwd: process.cwd(),
    lockedEnv: { ANTHROPIC_API_KEY: 'test-key' },
    harnessTransport: { kind: 'pty' },
    limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 500 },
  },
  interaction: {
    mode: 'interactive',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'claude-code-tmux',
    terminalHost: 'tmux',
  },
  correlation: {
    hostSessionId: 'host-session-driver-red',
    runtimeId: 'runtime-driver-red',
  },
})

export const loadFactory = async (): Promise<ClaudeCodeTmuxDriverFactory> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/driver')) as {
    createClaudeCodeTmuxDriver?: ClaudeCodeTmuxDriverFactory | undefined
  }
  if (target.createClaudeCodeTmuxDriver === undefined) {
    throw new Error('createClaudeCodeTmuxDriver export is required')
  }
  return target.createClaudeCodeTmuxDriver
}

export const loadSocketPathBuilder = async (): Promise<
  (socketDir: string, context: HookListenerMeta) => string
> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/driver')) as {
    buildClaudeHookSocketPath?:
      | ((socketDir: string, context: HookListenerMeta) => string)
      | undefined
  }
  if (target.buildClaudeHookSocketPath === undefined) {
    throw new Error('buildClaudeHookSocketPath export is required')
  }
  return target.buildClaudeHookSocketPath
}

/**
 * Recording tmux exec mock. `display-message` (the only verb the
 * TmuxPaneController issues during inspect()) returns the leased ids so
 * the driver's lease-vs-tmux integrity check passes by default. Tests that
 * exercise the mismatch path override this via `createMismatchingExec`.
 */
export function createRecordingExec(calls: TmuxExecCall[], lease: PaneLease = defaultLease()) {
  // Stateful so the launch's sendPastedLine confirm path (capture: true) resolves
  // deterministically: load-buffer stages the pasted line, capture-pane echoes it
  // back (so the render check sees the command present), and Enter clears it (so
  // the submit check sees the prompt advance). Without this the confirm path
  // would poll an empty capture until timeout on every start().
  let pendingLine = ''
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    const call: TmuxExecCall = { argv, env: options?.env }
    calls.push(call)
    if (argv.includes('display-message')) {
      return {
        stdout: `${lease.sessionId}\t${lease.windowId}\t${lease.paneId}\n`,
        stderr: '',
      }
    }
    if (argv.includes('load-buffer')) {
      pendingLine = readFileSync(argv.at(-1) ?? '', 'utf8')
      call.loadedText = pendingLine
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('send-keys') && argv.includes('Enter')) {
      // Enter submits the staged line; the prompt advances past it.
      pendingLine = ''
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('capture-pane')) {
      return { stdout: pendingLine, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
}

export function createMismatchingExec(calls: TmuxExecCall[]) {
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ argv, env: options?.env })
    if (argv.includes('display-message')) {
      // Tmux reports a DIFFERENT pane than the lease — the driver should
      // refuse to attach.
      return { stdout: '$99\t@99\t%99\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
}

export function createNotFoundExec(calls: TmuxExecCall[]) {
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ argv, env: options?.env })
    if (argv.includes('display-message')) {
      throw new Error("can't find pane: %7")
    }
    return { stdout: '', stderr: '' }
  }
}

export function createCtx(
  events: InvocationEventEnvelope[],
  runtime?: BrokerRuntimeContext | undefined,
  invocationId = 'inv_claude_tmux_1'
): DriverContext {
  const id = invocationIdFrom(invocationId)
  function emitEvent<K extends InvocationEventType>(
    event: InvocationEventFor<K>,
    extra?: Parameters<DriverContext['emitEvent']>[1]
  ): InvocationEventEnvelope<K>
  function emitEvent(
    event: InvocationEvent,
    extra?: Parameters<DriverContext['emitEvent']>[1]
  ): InvocationEventEnvelope {
    const envelope: InvocationEventEnvelope = {
      invocationId: id,
      seq: events.length + 1,
      time: now().toISOString(),
      ...event,
      ...extra,
    }
    events.push(envelope)
    return envelope
  }
  return {
    invocationId: id,
    clientCapabilities: {},
    ...(runtime !== undefined ? { runtime } : {}),
    emit: (type, payload, extra) => emitEvent({ type, payload }, extra),
    emitEvent,
  }
}

export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

export function specWithIds(invocationId: string, runtimeId: string): HarnessInvocationSpec {
  return {
    ...claudeTmuxSpec(),
    invocationId: invocationIdFrom(invocationId),
    correlation: {
      hostSessionId: `host-${runtimeId}`,
      runtimeId,
    },
  }
}

export function pastedTexts(calls: TmuxExecCall[]): string[] {
  return calls
    .filter((call) => call.argv.includes('load-buffer'))
    .map((call) => call.loadedText ?? '')
}

export function tmuxArgv(calls: TmuxExecCall[]): string[][] {
  return calls.map((call) => call.argv)
}

export function launchArtifact(calls: TmuxExecCall[]): LaunchArtifact {
  return JSON.parse(readFileSync(launchFilePath(calls), 'utf8')) as LaunchArtifact
}

function launchFilePath(calls: TmuxExecCall[]): string {
  // The launch command is delivered via sendPastedLine (load-buffer + paste-buffer),
  // so it lands in the pasted-buffer text, not a send-keys -l literal.
  const command = pastedTexts(calls).find((text) => text.includes('.claude.launch.json'))
  if (command === undefined) throw new Error('tmux launch artifact command was not sent')
  const match = command.match(/[^\s'"]+\.claude\.launch\.json/)
  if (!match) throw new Error(`unable to parse launch artifact path from: ${command}`)
  return match[0]
}

export function expectTargetsLeasedPane(calls: TmuxExecCall[], leasedPaneId: string): void {
  // Every send-keys / paste-buffer call must target the leased pane id via
  // `-t <leasedPaneId>`. load-buffer does not take a target. capture-pane is
  // only emitted if the test exercises capture; when present, it too must
  // target the leased pane.
  const targetingVerbs = new Set(['send-keys', 'paste-buffer', 'capture-pane'])
  for (const call of calls) {
    const argv = call.argv
    const verb = argv.find((part) => targetingVerbs.has(part))
    if (verb === undefined) continue
    const targetIndex = argv.indexOf('-t')
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    expect(argv[targetIndex + 1]).toBe(leasedPaneId)
  }
}

export function expectNoForbiddenLifecycleVerbs(calls: TmuxExecCall[]): void {
  const flat = tmuxArgv(calls).flat()
  for (const forbidden of FORBIDDEN_TMUX_VERBS) {
    expect(flat).not.toContain(forbidden)
  }
  // tmux -V is a server-version probe. The pane-leased driver must not issue it.
  expect(flat).not.toContain('-V')
}

export type HookDriverRun = {
  driver: ReturnType<ClaudeCodeTmuxDriverFactory>
  events: InvocationEventEnvelope[]
  tmuxCalls: TmuxExecCall[]
  socketPath: string
  transcriptPath: string
  /** Deliver one hook envelope through the driver's captured `hooks.listen` handler. */
  hook: (hookData: Record<string, unknown>, turnId?: string) => Promise<unknown>
  /** Emitted events of one type, in order. */
  ofType: (type: InvocationEventType) => InvocationEventEnvelope[]
  messages: () => InvocationEventEnvelope[]
  cleanup: () => Promise<void>
}

/**
 * Start the claude-code-tmux driver on the recording tmux exec with a fake
 * hook listener, a temp transcript and a temp hook socket. Unless
 * `sessionStart` is false, a SessionStart hook names the transcript, so rows
 * appended to `transcriptPath` reach the driver on the next hook.
 */
export async function startHookDriver(
  options: {
    driverOptions?: Record<string, unknown> | undefined
    spec?: HarnessInvocationSpec | undefined
    transcript?: string | undefined
    sessionStart?: boolean | undefined
  } = {}
): Promise<HookDriverRun> {
  const createDriver = await loadFactory()
  const tmuxCalls: TmuxExecCall[] = []
  let handler: ((envelope: HookEnvelope) => Promise<unknown>) | undefined
  const events: InvocationEventEnvelope[] = []
  const root = mkdtempSync(join(tmpdir(), 'claude-tmux-driver-'))
  const transcriptPath = join(root, 'session.jsonl')
  writeFileSync(transcriptPath, options.transcript ?? '')
  const socketPath = join(root, 'claude-hooks.sock')
  const driver = createDriver({
    tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
    hooks: {
      listen: async (listener) => {
        handler = listener as (envelope: HookEnvelope) => Promise<unknown>
        return { socketPath, close: async () => undefined }
      },
    },
    now,
    ...options.driverOptions,
  })
  const spec = options.spec ?? claudeTmuxSpec()
  await driver.start(
    spec,
    createCtx(events, { terminalSurface: defaultLease() }, spec.invocationId)
  )
  const hook = async (hookData: Record<string, unknown>, turnId?: string) =>
    handler?.({
      invocationId:
        spec.invocationId ??
        (() => {
          throw new Error('hook fixture requires an invocation id')
        })(),
      generation: 1,
      callbackSocket: socketPath,
      ...(turnId !== undefined ? { turnId } : {}),
      hookData,
    })
  if (options.sessionStart !== false) {
    await hook({ hook_event_name: 'SessionStart', transcript_path: transcriptPath })
  }
  const ofType = (type: InvocationEventType) => events.filter((event) => event.type === type)
  return {
    driver,
    events,
    tmuxCalls,
    socketPath,
    transcriptPath,
    hook,
    ofType,
    messages: () => ofType('assistant.message.completed'),
    cleanup: async () => {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
