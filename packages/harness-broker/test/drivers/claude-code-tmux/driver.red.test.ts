import { describe, expect, test } from 'bun:test'
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

type ClaudeCodeTmuxDriverFactory = (options: {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec: (
      argv: string[],
      options?: { env?: Record<string, string | undefined> | undefined }
    ) => Promise<{ stdout: string; stderr: string }>
  }
  hooks: {
    listen: (handler: (envelope: HookEnvelope) => Promise<void>) => Promise<{
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

function createRecordingExec(calls: TmuxExecCall[]) {
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ argv, env: options?.env })
    const command = argv.at(-1)
    if (command === '-V') return { stdout: 'tmux 3.3\n', stderr: '' }
    if (argv.includes('list-panes')) {
      throw new Error("can't find session: hrc-host-sessio")
    }
    if (argv.includes('new-session')) {
      return { stdout: '$1\t@1\t%7\thrc-host-sessio\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
}

function createCtx(events: InvocationEventEnvelope[]): DriverContext {
  return {
    invocationId: 'inv_claude_tmux_1',
    clientCapabilities: {},
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
  }
}

function sentLiteralTexts(calls: TmuxExecCall[]): string[] {
  return calls
    .map((call) => call.argv)
    .filter((argv) => argv.includes('send-keys') && argv.includes('-l'))
    .map((argv) => argv.at(-1) ?? '')
}

describe('claude-code-tmux driver RED lifecycle', () => {
  test('start reports the runtime tmux attach surface with the driver envelope', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/claude-tmux.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })

    await driver.start(claudeTmuxSpec(), createCtx(events))

    expect(hookHandler).toBeDefined()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal.surface.reported',
        payload: {
          kind: 'tmux-session',
          socketPath: '/tmp/harness-broker/claude-tmux.sock',
          sessionName: 'hrc-host-sessio',
          paneId: '%7',
        },
        driver: { kind: 'claude-code-tmux', rawType: 'tmux.surface' },
      })
    )
    expect(tmuxCalls.some((call) => call.argv.includes('new-session'))).toBe(true)
  })

  test('applyInputNow delivers user text as literal tmux input followed by Enter', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/claude-tmux.sock',
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
    await driver.start(claudeTmuxSpec(), createCtx(events))

    await driver.applyInputNow({
      inputId: 'input_apply_1',
      kind: 'user',
      content: [{ type: 'text', text: 'please continue $WITHOUT_EXPANSION' }],
    })

    expect(tmuxCalls.map((call) => call.argv)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      '/tmp/harness-broker/claude-tmux.sock',
      'send-keys',
      '-l',
      '-t',
      '%7',
      'please continue $WITHOUT_EXPANSION',
    ])
    expect(tmuxCalls.map((call) => call.argv)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      '/tmp/harness-broker/claude-tmux.sock',
      'send-keys',
      '-t',
      '%7',
      'Enter',
    ])
  })

  test('hook envelopes received by the driver flow through ctx.emit in start-to-complete order', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/claude-tmux.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })
    await driver.start(claudeTmuxSpec(), createCtx(events))

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
    expect(events.filter((event) => event.turnId === 'turn_driver_envelope_1').map((event) => event.type)).toEqual([
      'turn.started',
      'tool.call.started',
      'turn.completed',
    ])
  })

  test('start installs a real Claude hook bridge in the tmux launch, not only broker env vars', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/claude-tmux.sock',
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

    await driver.start(claudeTmuxSpec(), createCtx([]))

    const launchCommand = sentLiteralTexts(tmuxCalls).find((text) =>
      text.includes('/opt/bin/claude')
    )
    expect(launchCommand).toBeDefined()
    expect(launchCommand).toContain('/tmp/harness-broker/claude-hooks.sock')

    // Env vars alone do not make Claude Code invoke hooks. The tmux launch must
    // include a Claude hook settings overlay / hook command so the real runtime
    // posts these events back to the broker callback socket.
    expect(launchCommand).toContain('--settings')
    expect(launchCommand).toContain('hook')
    for (const hookName of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      expect(launchCommand).toContain(hookName)
    }
  })

  test('applyInputNow tracks the active broker turn id for raw hook envelopes with no turn id', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/claude-tmux.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })
    await driver.start(claudeTmuxSpec(), createCtx(events))

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
})
