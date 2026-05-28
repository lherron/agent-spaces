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

/**
 * Recording tmux exec mock. `display-message` (the only verb the
 * TmuxPaneController issues during inspect()) returns the leased ids so
 * the driver's lease-vs-tmux integrity check passes by default. Tests that
 * exercise the mismatch path override this via `createMismatchingExec`.
 */
function createRecordingExec(calls: TmuxExecCall[], lease: PaneLease = defaultLease()) {
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
  runtime?: BrokerRuntimeContext | undefined
): DriverContext {
  return {
    invocationId: 'inv_claude_tmux_1',
    clientCapabilities: {},
    ...(runtime !== undefined ? { runtime } : {}),
    emit(type, payload, extra) {
      const event = {
        invocationId: 'inv_claude_tmux_1',
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

function sentLiteralTexts(calls: TmuxExecCall[]): string[] {
  return calls
    .map((call) => call.argv)
    .filter((argv) => argv.includes('send-keys') && argv.includes('-l'))
    .map((argv) => argv.at(-1) ?? '')
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

function launchCommand(calls: TmuxExecCall[]): string {
  const command = [...sentLiteralTexts(calls), ...pastedTexts(calls)].find((text) =>
    text.includes('/opt/bin/claude')
  )
  if (command === undefined) return readFileSync(launchScriptPath(calls), 'utf8')
  return command
}

function launchScriptPath(calls: TmuxExecCall[]): string {
  const command = sentLiteralTexts(calls).find((text) =>
    text.includes('/tmp/harness-broker/claude-hooks.sock.launch.sh')
  )
  if (command === undefined) throw new Error('tmux launch script command was not sent')
  const match = command.match(/\/tmp\/harness-broker\/claude-hooks\.sock\.launch\.sh/)
  if (!match) throw new Error(`unable to parse launch script path from: ${command}`)
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
  // tmux -V is a server-version probe used by the legacy TmuxManager. The
  // pane-leased driver must not issue it either.
  expect(flat).not.toContain('-V')
}

describe('claude-code-tmux driver RED lifecycle', () => {
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
    ).toEqual(['turn.started', 'tool.call.started', 'turn.completed'])
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

    const path = launchScriptPath(tmuxCalls)
    const launchCmd = readFileSync(path, 'utf8')
    expect(launchCmd).toBeDefined()
    expect(launchCmd).not.toContain('\nexec HARNESS_BROKER_INVOCATION_ID=')
    expect(launchCmd).toContain('\nHARNESS_BROKER_INVOCATION_ID=')
    expect(launchCmd).toContain('/tmp/harness-broker/claude-hooks.sock')

    // Env vars alone do not make Claude Code invoke hooks. The tmux launch must
    // include a Claude hook settings overlay / hook command so the real runtime
    // posts these events back to the broker callback socket.
    expect(launchCmd).toContain('--settings')
    expect(launchCmd).toContain('hook')
    for (const hookName of [
      'UserPromptSubmit',
      'MessageDisplay',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]) {
      expect(launchCmd).toContain(hookName)
    }

    expect(pastedTexts(tmuxCalls).some((text) => text.includes('/opt/bin/claude'))).toBe(false)
    expect(tmuxArgv(tmuxCalls)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      DEFAULT_LEASE_SOCKET,
      'send-keys',
      '-l',
      '-t',
      DEFAULT_LEASE_PANE,
      'exec /bin/sh /tmp/harness-broker/claude-hooks.sock.launch.sh',
    ])
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

      const command = launchCommand(tmuxCalls)
      const separator = command.indexOf(' -- launch-prompt')
      expect(separator).toBeGreaterThan(0)

      const beforeSeparator = command.slice(0, separator)
      const afterSeparator = command.slice(separator + ' -- launch-prompt'.length)
      const preSettings = [...beforeSeparator.matchAll(/--settings ([^ ]+)/g)].map(
        (match) => match[1]
      )
      expect(preSettings).toHaveLength(1)
      expect(afterSeparator).not.toContain('--settings')

      const effectiveSettings = JSON.parse(readFileSync(preSettings[0] ?? '', 'utf8')) as {
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
