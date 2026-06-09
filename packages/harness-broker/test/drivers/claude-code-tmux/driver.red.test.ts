import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../../../src/drivers/driver'

type TmuxExecCall = {
  argv: string[]
  env?: Record<string, string | undefined> | undefined
}

type HookEnvelope = {
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
}) => {
  kind: string
  start: (spec: HarnessInvocationSpec, ctx: DriverContext) => Promise<{ ok: true }>
  applyInputNow: (input: InvocationInput) => Promise<{ turnId?: string | undefined }>
  stop: (req: { reason?: string | undefined }) => Promise<{ accepted: boolean; state: string }>
  dispose: () => Promise<void>
}

type HookListenerMeta = {
  invocationId: string
  runtimeId?: string | undefined
}

const now = () => new Date('2026-05-26T15:30:00.000Z')

const DEFAULT_LEASE_SOCKET = '/tmp/preallocated/hrc-owned-tmux.sock'
const DEFAULT_LEASE_PANE = '%7'
const DEFAULT_LEASE_SESSION = '$1'
const DEFAULT_LEASE_WINDOW = '@1'
const DEFAULT_LEASE_SESSION_NAME = 'hrc-host-sessio'

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

function defaultLease(): PaneLease {
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

const claudeTmuxSpec = (): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: 'inv_claude_tmux_1',
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

const loadFactory = async (): Promise<ClaudeCodeTmuxDriverFactory> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/driver')) as {
    createClaudeCodeTmuxDriver?: ClaudeCodeTmuxDriverFactory | undefined
  }
  if (target.createClaudeCodeTmuxDriver === undefined) {
    throw new Error('createClaudeCodeTmuxDriver export is required')
  }
  return target.createClaudeCodeTmuxDriver
}

const loadSocketPathBuilder = async (): Promise<
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
function createRecordingExec(calls: TmuxExecCall[], lease: PaneLease = defaultLease()) {
  // Stateful so the launch's sendPastedLine confirm path (capture: true) resolves
  // deterministically: set-buffer stages the pasted line, capture-pane echoes it
  // back (so the render check sees the command present), and Enter clears it (so
  // the submit check sees the prompt advance). Without this the confirm path
  // would poll an empty capture until timeout on every start().
  let pendingLine = ''
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ argv, env: options?.env })
    if (argv.includes('display-message')) {
      return {
        stdout: `${lease.sessionId}\t${lease.windowId}\t${lease.paneId}\n`,
        stderr: '',
      }
    }
    if (argv.includes('set-buffer')) {
      pendingLine = argv.at(-1) ?? ''
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

function createMismatchingExec(calls: TmuxExecCall[]) {
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

function createNotFoundExec(calls: TmuxExecCall[]) {
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

function createCtx(
  events: InvocationEventEnvelope[],
  runtime?: BrokerRuntimeContext | undefined,
  invocationId = 'inv_claude_tmux_1'
): DriverContext {
  return {
    invocationId,
    clientCapabilities: {},
    ...(runtime !== undefined ? { runtime } : {}),
    emit(type, payload, extra) {
      const event = {
        invocationId,
        seq: events.length + 1,
        time: now().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
  } as DriverContext
}

function specWithIds(invocationId: string, runtimeId: string): HarnessInvocationSpec {
  return {
    ...claudeTmuxSpec(),
    invocationId,
    correlation: {
      hostSessionId: `host-${runtimeId}`,
      runtimeId,
    },
  }
}

function pastedTexts(calls: TmuxExecCall[]): string[] {
  return calls
    .map((call) => call.argv)
    .filter((argv) => argv.includes('set-buffer'))
    .map((argv) => argv.at(-1) ?? '')
}

function tmuxArgv(calls: TmuxExecCall[]): string[][] {
  return calls.map((call) => call.argv)
}

function launchArtifact(calls: TmuxExecCall[]): LaunchArtifact {
  return JSON.parse(readFileSync(launchFilePath(calls), 'utf8')) as LaunchArtifact
}

function launchFilePath(calls: TmuxExecCall[]): string {
  // The launch command is delivered via sendPastedLine (set-buffer + paste-buffer),
  // so it lands in the pasted-buffer text, not a send-keys -l literal.
  const command = pastedTexts(calls).find((text) =>
    text.includes('/tmp/harness-broker/claude-hooks.sock.claude.launch.json')
  )
  if (command === undefined) throw new Error('tmux launch artifact command was not sent')
  const match = command.match(/\/tmp\/harness-broker\/claude-hooks\.sock\.claude\.launch\.json/)
  if (!match) throw new Error(`unable to parse launch artifact path from: ${command}`)
  return match[0]
}

function expectTargetsLeasedPane(calls: TmuxExecCall[], leasedPaneId: string): void {
  // Every send-keys / paste-buffer call must target the leased pane id via
  // `-t <leasedPaneId>`. set-buffer does not take a target. capture-pane is
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

function expectNoForbiddenLifecycleVerbs(calls: TmuxExecCall[]): void {
  const flat = tmuxArgv(calls).flat()
  for (const forbidden of FORBIDDEN_TMUX_VERBS) {
    expect(flat).not.toContain(forbidden)
  }
  // tmux -V is a server-version probe. The pane-leased driver must not issue it.
  expect(flat).not.toContain('-V')
}

describe('claude-code-tmux driver RED lifecycle', () => {
  test('advertises no live driver attach-to-existing-surface support distinct from operator attach', async () => {
    const createDriver = await loadFactory()
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec([]),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    // T-01794 Phase D: control.attach means operator can attach to the TUI.
    // It must not imply the broker can restart and reattach this driver to an
    // already-live surface; that separate capability defaults false.
    expect(driver.capabilities().control.attach).toBe(true)
    expect(driver.capabilities().control.driverAttachExistingSurface).toBe(false)
  })

  test('default hook callback socket path is unique per invocation and runtime', async () => {
    const buildSocketPath = await loadSocketPathBuilder()
    const first = buildSocketPath('/tmp/harness-broker', {
      invocationId: 'inv_first_concurrent',
      runtimeId: 'runtime-first-concurrent',
    })
    const second = buildSocketPath('/tmp/harness-broker', {
      invocationId: 'inv_second_concurrent',
      runtimeId: 'runtime-second-concurrent',
    })

    expect(first).not.toBe('/tmp/harness-broker/claude-hooks.sock')
    expect(second).not.toBe('/tmp/harness-broker/claude-hooks.sock')
    expect(first).not.toBe(second)
    expect(first.split('/').at(-1)).toMatch(/^claude-hooks\.[0-9a-f]{16}\.sock$/)
    expect(second.split('/').at(-1)).toMatch(/^claude-hooks\.[0-9a-f]{16}\.sock$/)
  })

  test('default hook callback socket path stays below macOS unix socket path limit with realistic TMPDIR', async () => {
    const buildSocketPath = await loadSocketPathBuilder()
    const socketPath = buildSocketPath(
      '/var/folders/c0/klfmxdkd20x6qnclf4zbvgnh0000gn/T/harness-broker',
      {
        invocationId: 'inv-8a4010c1-88c8-4296-8fdc-407ba5c2de15',
        runtimeId: 'rt-cf950440-b3c7-4e4b-99b6-10fe6370ef6d',
      }
    )

    expect(socketPath.length).toBeLessThan(104)
  })

  test('start reports the leased tmux pane surface with the driver envelope', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })

    await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))

    expect(hookHandler).toBeDefined()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal.surface.reported',
        payload: {
          kind: 'tmux-pane',
          socketPath: DEFAULT_LEASE_SOCKET,
          sessionId: DEFAULT_LEASE_SESSION,
          windowId: DEFAULT_LEASE_WINDOW,
          paneId: DEFAULT_LEASE_PANE,
          sessionName: DEFAULT_LEASE_SESSION_NAME,
        },
        driver: { kind: 'claude-code-tmux', rawType: 'tmux.surface' },
      })
    )
    // The driver MUST validate the lease through display-message before
    // launching anything in the pane.
    expect(tmuxCalls.some((call) => call.argv.includes('display-message'))).toBe(true)
    expectNoForbiddenLifecycleVerbs(tmuxCalls)
    expectTargetsLeasedPane(tmuxCalls, DEFAULT_LEASE_PANE)
  })

  test('applyInputNow delivers user text as literal tmux input followed by Enter targeting the leased pane', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })
    const events: InvocationEventEnvelope[] = []
    await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))

    await driver.applyInputNow({
      inputId: 'input_apply_1',
      kind: 'user',
      content: [{ type: 'text', text: 'please continue $WITHOUT_EXPANSION' }],
    })

    expect(tmuxCalls.map((call) => call.argv)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      DEFAULT_LEASE_SOCKET,
      'send-keys',
      '-l',
      '-t',
      DEFAULT_LEASE_PANE,
      'please continue $WITHOUT_EXPANSION',
    ])
    expect(tmuxCalls.map((call) => call.argv)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      DEFAULT_LEASE_SOCKET,
      'send-keys',
      '-t',
      DEFAULT_LEASE_PANE,
      'Enter',
    ])
    expectNoForbiddenLifecycleVerbs(tmuxCalls)
    expectTargetsLeasedPane(tmuxCalls, DEFAULT_LEASE_PANE)
  })

  test('hook envelopes received by the driver flow through ctx.emit in start-to-complete order', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })
    await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))

    await hookHandler?.({
      invocationId: 'inv_claude_tmux_1',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
      turnId: 'turn_driver_envelope_1',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
    })
    await hookHandler?.({
      invocationId: 'inv_claude_tmux_1',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
      turnId: 'turn_driver_envelope_1',
      hookData: {
        hook_event_name: 'PreToolUse',
        tool_use_id: 'toolu_1',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      },
    })
    await hookHandler?.({
      invocationId: 'inv_claude_tmux_1',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
      turnId: 'turn_driver_envelope_1',
      hookData: { hook_event_name: 'Stop' },
    })

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['turn.started', 'tool.call.started', 'turn.completed'])
    )
    expect(
      events.filter((event) => event.turnId === 'turn_driver_envelope_1').map((event) => event.type)
    ).toEqual(['turn.started', 'user.message', 'tool.call.started', 'turn.completed'])
  })

  test('durable hook envelopes reject mismatched generation but accept matching identity', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const hookSocket =
      '/tmp/praesidium/runtime/broker-ipc/runtime-claude/hooks/claude-hooks.live.sock'
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return {
            socketPath: hookSocket,
            close: async () => undefined,
          }
        },
      },
      now,
    })

    await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
    if (hookHandler === undefined) throw new Error('hook handler was not captured')

    const baseline = events.length
    await hookHandler({
      invocationId: 'inv_claude_tmux_1',
      runtimeId: 'runtime-driver-red',
      generation: 2,
      callbackSocket: hookSocket,
      turnId: 'turn_driver_generation_mismatch',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'foreign generation' },
    })
    expect(events).toHaveLength(baseline)

    await hookHandler({
      invocationId: 'inv_claude_tmux_1',
      runtimeId: 'runtime-driver-red',
      generation: 1,
      callbackSocket: hookSocket,
      turnId: 'turn_driver_generation_match',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'live generation' },
    })
    expect(events.slice(baseline).map((event) => event.type)).toEqual([
      'turn.started',
      'user.message',
    ])
  })

  test('second concurrent hook listener ignores stale envelopes from the first invocation', async () => {
    const createDriver = await loadFactory()
    const firstTmuxCalls: TmuxExecCall[] = []
    const secondTmuxCalls: TmuxExecCall[] = []
    const firstEvents: InvocationEventEnvelope[] = []
    const secondEvents: InvocationEventEnvelope[] = []
    const hookHandlers: Array<(envelope: HookEnvelope) => Promise<void>> = []
    const listenerMetas: HookListenerMeta[] = []

    const firstDriver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(firstTmuxCalls),
      },
      hooks: {
        listen: async (handler, meta?: HookListenerMeta) => {
          hookHandlers.push(handler as (envelope: HookEnvelope) => Promise<void>)
          if (meta !== undefined) listenerMetas.push(meta)
          return {
            socketPath: `/tmp/harness-broker/claude-hooks.${meta?.invocationId ?? 'missing'}.sock`,
            close: async () => undefined,
          }
        },
      },
      now,
    })
    const secondDriver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(secondTmuxCalls),
      },
      hooks: {
        listen: async (handler, meta?: HookListenerMeta) => {
          hookHandlers.push(handler as (envelope: HookEnvelope) => Promise<void>)
          if (meta !== undefined) listenerMetas.push(meta)
          return {
            socketPath: `/tmp/harness-broker/claude-hooks.${meta?.invocationId ?? 'missing'}.sock`,
            close: async () => undefined,
          }
        },
      },
      now,
    })

    await firstDriver.start(
      specWithIds('inv_first_concurrent', 'runtime-first-concurrent'),
      createCtx(firstEvents, { terminalSurface: defaultLease() }, 'inv_first_concurrent')
    )
    await secondDriver.start(
      specWithIds('inv_second_concurrent', 'runtime-second-concurrent'),
      createCtx(secondEvents, { terminalSurface: defaultLease() }, 'inv_second_concurrent')
    )

    expect(listenerMetas).toEqual([
      { invocationId: 'inv_first_concurrent', runtimeId: 'runtime-first-concurrent' },
      { invocationId: 'inv_second_concurrent', runtimeId: 'runtime-second-concurrent' },
    ])

    const secondHandler = hookHandlers[1]
    if (secondHandler === undefined) throw new Error('second hook handler was not captured')

    await secondHandler({
      invocationId: 'inv_first_concurrent',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-hooks.inv_first_concurrent.sock',
      runtimeId: 'runtime-first-concurrent',
      turnId: 'turn_foreign_1',
      hookData: {
        hook_event_name: 'MessageDisplay',
        message_id: 'msg_foreign_1',
        index: 0,
        delta: 'foreign assistant text',
        final: true,
      },
    })
    await secondHandler({
      invocationId: 'inv_first_concurrent',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-hooks.inv_first_concurrent.sock',
      runtimeId: 'runtime-first-concurrent',
      turnId: 'turn_foreign_1',
      hookData: {
        hook_event_name: 'Stop',
        last_assistant_message: 'foreign assistant text',
      },
    })

    expect(secondEvents.map((event) => event.type)).toEqual(['terminal.surface.reported'])
    expect(JSON.stringify(secondEvents)).not.toContain('foreign assistant text')
  })

  test('start installs a real Claude hook bridge in the tmux launch, not only broker env vars', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))

    const artifact = launchArtifact(tmuxCalls)
    expect(artifact.argv).toContain('/opt/bin/claude')
    expect(artifact.env?.['HARNESS_BROKER_INVOCATION_ID']).toBe('inv_claude_tmux_1')
    expect(artifact.env?.['HARNESS_BROKER_RUNTIME_ID']).toBe('runtime-driver-red')
    expect(artifact.env?.['HARNESS_BROKER_CALLBACK_SOCKET']).toBe(
      '/tmp/harness-broker/claude-hooks.sock'
    )

    // Env vars alone do not make Claude Code invoke hooks. The tmux launch must
    // include a Claude hook settings overlay / hook command so the real runtime
    // posts these events back to the broker callback socket.
    expect(artifact.argv).toContain('--settings')
    const settingsPath = artifact.argv[artifact.argv.indexOf('--settings') + 1]
    const settings = JSON.parse(readFileSync(settingsPath ?? '', 'utf8')) as {
      hooks?: Record<string, unknown>
    }
    expect(JSON.stringify(settings.hooks)).toContain('harness-broker claude-hook')
    for (const hookName of [
      'UserPromptSubmit',
      'MessageDisplay',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]) {
      expect(settings.hooks?.[hookName]).toBeDefined()
    }

    // The raw claude binary is never typed at the prompt — only the launch-runner
    // command line is, with the binary path captured inside the JSON artifact.
    expect(pastedTexts(tmuxCalls).some((text) => text.includes('/opt/bin/claude'))).toBe(false)
    // T-01747 parity with codex-cli-tmux: the launch is delivered via the
    // paste-confirm-submit path (set-buffer + paste-buffer), NOT a blind
    // send-keys -l. The command runs the real launch-runner module against the
    // JSON launch artifact written beside the hook socket.
    const launchSetBuffer = tmuxArgv(tmuxCalls).find(
      (argv) => argv.includes('set-buffer') && (argv.at(-1) ?? '').includes('tmux-launch-runner')
    )
    expect(launchSetBuffer?.at(-1)).toMatch(
      /^exec bun \S*tmux-launch-runner\.(ts|js) --launch-file \/tmp\/harness-broker\/claude-hooks\.sock\.claude\.launch\.json$/
    )
    // The launch command is NOT typed as a send-keys -l literal (that path is the
    // pre-T-01747 blind delivery the codex driver already abandoned).
    const launchSendKeys = tmuxArgv(tmuxCalls).find(
      (argv) =>
        argv.includes('send-keys') &&
        argv.includes('-l') &&
        (argv.at(-1) ?? '').includes('tmux-launch-runner')
    )
    expect(launchSendKeys).toBeUndefined()
    // paste-buffer targets the leased pane and Enter submits the staged line.
    expect(tmuxArgv(tmuxCalls)).toContainEqual(
      expect.arrayContaining(['paste-buffer', '-t', DEFAULT_LEASE_PANE])
    )
    expect(tmuxArgv(tmuxCalls)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      DEFAULT_LEASE_SOCKET,
      'send-keys',
      '-t',
      DEFAULT_LEASE_PANE,
      'Enter',
    ])
  })

  test('threads spec.process.lockedEnv and ctx.dispatchEnv into the tmux launch env (codex parity)', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    // Per-invocation HRC correlation env rides on ctx.dispatchEnv (HRC_SESSION_REF,
    // ASP_PROJECT, …). Like codex-cli-tmux, the claude driver must merge both
    // spec.process.lockedEnv and ctx.dispatchEnv into the launched pane env —
    // otherwise the in-pane agent loses "me"/project resolution.
    const ctx = {
      ...createCtx([], { terminalSurface: defaultLease() }),
      dispatchEnv: {
        HRC_SESSION_REF: 'agent:clod:project:agent-spaces:task:primary/lane:main',
        ASP_PROJECT: 'agent-spaces',
      },
    } as DriverContext
    await driver.start(claudeTmuxSpec(), ctx)

    const artifact = launchArtifact(tmuxCalls)
    // lockedEnv (claudeTmuxSpec sets ANTHROPIC_API_KEY)
    expect(artifact.env?.['ANTHROPIC_API_KEY']).toBe('test-key')
    // dispatchEnv correlation vars
    expect(artifact.env?.['HRC_SESSION_REF']).toBe(
      'agent:clod:project:agent-spaces:task:primary/lane:main'
    )
    expect(artifact.env?.['ASP_PROJECT']).toBe('agent-spaces')
    // broker hook vars still present and not clobbered by the spreads
    expect(artifact.env?.['HARNESS_BROKER_INVOCATION_ID']).toBe('inv_claude_tmux_1')
  })

  test('interrupt/stop lifecycle matches codex-cli-tmux (C-c live, no_active_turn after stop)', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    // Before start: nothing is live.
    expect(await driver.interrupt({} as never)).toEqual({
      accepted: false,
      effect: 'no_active_turn',
    })

    await driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))

    // Live: interrupt fires a real C-c at the leased pane.
    expect(await driver.interrupt({} as never)).toEqual({
      accepted: true,
      effect: 'turn_interrupted',
    })
    expect(tmuxArgv(tmuxCalls)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      DEFAULT_LEASE_SOCKET,
      'send-keys',
      '-t',
      DEFAULT_LEASE_PANE,
      'C-c',
    ])

    // After stop: surface is dropped, so interrupt no longer fires C-c (parity
    // with codex — a stopped driver reports no_active_turn).
    expect(await driver.stop({} as never)).toEqual({ accepted: true, state: 'exited' })
    const callsAfterStop = tmuxCalls.length
    expect(await driver.interrupt({} as never)).toEqual({
      accepted: false,
      effect: 'no_active_turn',
    })
    expect(tmuxCalls.length).toBe(callsAfterStop)
  })

  test('merges broker hooks into the effective pre-separator Claude settings file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claude-tmux-driver-settings-'))
    try {
      const durableSettingsPath = join(tmp, 'settings.json')
      const durableStatusLine = {
        type: 'command',
        command: 'bash /tmp/statusline.sh',
      }
      writeFileSync(
        durableSettingsPath,
        JSON.stringify({ statusLine: durableStatusLine }, null, 2),
        'utf8'
      )

      const createDriver = await loadFactory()
      const tmuxCalls: TmuxExecCall[] = []
      const driver = createDriver({
        tmux: {
          tmuxBin: '/opt/bin/tmux',
          exec: createRecordingExec(tmuxCalls),
        },
        hooks: {
          listen: async () => ({
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }),
        },
        now,
      })
      const spec = claudeTmuxSpec()
      spec.process.args = [
        '--model',
        'sonnet',
        '--settings',
        durableSettingsPath,
        '--',
        'launch-prompt',
      ]

      await driver.start(spec, createCtx([], { terminalSurface: defaultLease() }))

      const argv = launchArtifact(tmuxCalls).argv
      const separator = argv.indexOf('--')
      expect(separator).toBeGreaterThan(0)

      const preSeparatorArgs = argv.slice(0, separator)
      const postSeparatorArgs = argv.slice(separator)
      const settingsIndex = preSeparatorArgs.indexOf('--settings')
      expect(settingsIndex).toBeGreaterThan(0)
      expect(preSeparatorArgs.filter((arg) => arg === '--settings')).toHaveLength(1)
      expect(postSeparatorArgs).toEqual(['--', 'launch-prompt'])
      expect(postSeparatorArgs).not.toContain('--settings')

      const effectiveSettings = JSON.parse(
        readFileSync(preSeparatorArgs[settingsIndex + 1] ?? '', 'utf8')
      ) as {
        statusLine?: unknown
        hooks?: Record<string, unknown>
      }
      expect(effectiveSettings.statusLine).toEqual(durableStatusLine)
      expect(effectiveSettings.hooks).toBeDefined()
      for (const hookName of [
        'UserPromptSubmit',
        'MessageDisplay',
        'PreToolUse',
        'PostToolUse',
        'Stop',
      ]) {
        expect(JSON.stringify(effectiveSettings.hooks?.[hookName])).toContain(
          'harness-broker claude-hook --socket /tmp/harness-broker/claude-hooks.sock'
        )
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('applyInputNow tracks the active broker turn id for raw hook envelopes with no turn id', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })
    await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))

    const applied = await driver.applyInputNow({
      inputId: 'input_active_turn_1',
      kind: 'user',
      content: [{ type: 'text', text: 'drive a real hooked turn' }],
    })
    expect(typeof applied.turnId).toBe('string')

    await hookHandler?.({
      invocationId: 'inv_claude_tmux_1',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'drive a real hooked turn' },
    })
    await hookHandler?.({
      invocationId: 'inv_claude_tmux_1',
      generation: 1,
      callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
      hookData: { hook_event_name: 'Stop' },
    })

    const activeTurnId = applied.turnId
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.started',
        turnId: activeTurnId,
        payload: { turnId: activeTurnId },
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.completed',
        turnId: activeTurnId,
        payload: { turnId: activeTurnId, status: 'completed' },
      })
    )
  })

  test('uses the leased tmux socket and pane in argv and terminal.surface.reported', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))

    // Driver path never uses the construction-time default socket — it
    // attaches to the leased socket.
    expect(
      tmuxArgv(tmuxCalls).every(
        (argv) => !argv.includes('/tmp/harness-broker/hidden-default-should-not-be-used.sock')
      )
    ).toBe(true)
    expect(tmuxArgv(tmuxCalls).every((argv) => !argv.includes(DEFAULT_LEASE_SOCKET) || true)).toBe(
      true
    )
    expect(
      tmuxArgv(tmuxCalls).some((argv) => argv.includes('-S') && argv.includes(DEFAULT_LEASE_SOCKET))
    ).toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal.surface.reported',
        payload: expect.objectContaining({
          kind: 'tmux-pane',
          socketPath: DEFAULT_LEASE_SOCKET,
          sessionId: DEFAULT_LEASE_SESSION,
          windowId: DEFAULT_LEASE_WINDOW,
          paneId: DEFAULT_LEASE_PANE,
        }),
      })
    )
  })

  test('rejects start when no runtime terminalSurface lease is supplied', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await expect(driver.start(claudeTmuxSpec(), createCtx([]))).rejects.toThrow(/terminalSurface/i)
    expect(tmuxCalls).toEqual([])
  })

  test('rejects start when leased pane is not found by inspect', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createNotFoundExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await expect(
      driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))
    ).rejects.toThrow(/leased pane not found or id mismatch/i)
    // Inspect was attempted, but no send-keys / launch ever happened.
    expect(tmuxCalls.some((call) => call.argv.includes('display-message'))).toBe(true)
    expect(tmuxCalls.every((call) => !call.argv.includes('send-keys'))).toBe(true)
  })

  test('rejects start when tmux reports ids that disagree with the lease', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createMismatchingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await expect(
      driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))
    ).rejects.toThrow(/leased pane not found or id mismatch/i)
    expect(tmuxCalls.every((call) => !call.argv.includes('send-keys'))).toBe(true)
  })

  test('start never issues forbidden tmux lifecycle commands', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))

    expectNoForbiddenLifecycleVerbs(tmuxCalls)
    expectTargetsLeasedPane(tmuxCalls, DEFAULT_LEASE_PANE)
  })

  test('dispose does NOT kill the tmux session or server', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/claude-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })
    await driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))

    await driver.dispose()

    expectNoForbiddenLifecycleVerbs(tmuxCalls)
  })
})
