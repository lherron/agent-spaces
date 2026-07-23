import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../../../src/drivers/driver'

type TmuxExecCall = { argv: string[]; env?: Record<string, string | undefined> | undefined }

type HookEnvelope = {
  invocationId?: string | undefined
  generation?: number | undefined
  callbackSocket?: string | undefined
  runtimeId?: string | undefined
  turnId?: string | undefined
  hookData?: unknown
  mailStopDecision?: { decision: 'block'; reason: string } | undefined
}

type HookResult = Record<string, unknown> | undefined

type LaunchArtifact = {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined> | undefined
}

type CodexCliTmuxDriverFactory = (options: {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec: (
      argv: string[],
      options?: { env?: Record<string, string | undefined> | undefined }
    ) => Promise<{ stdout: string; stderr: string }>
  }
  hooks: {
    listen: (handler: (envelope: HookEnvelope) => Promise<HookResult> | HookResult) => Promise<{
      socketPath: string
      close: () => Promise<void>
    }>
  }
  now: () => Date
}) => {
  kind: string
  capabilities: () => ReturnType<import('../../../src/drivers/driver').Driver['capabilities']>
  start: (spec: HarnessInvocationSpec, ctx: DriverContext) => Promise<{ ok: true }>
  applyInputNow: (input: InvocationInput) => Promise<Record<string, never>>
  stop: (req: { reason?: string | undefined }) => Promise<{ accepted: boolean; state: string }>
  dispose: () => Promise<void>
}

type TerminalSurfaceLease = {
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

const now = () => new Date('2026-05-27T17:31:00.000Z')
const invocationId = 'inv_codex_tmux_driver_1'

const codexTmuxSpec = (): HarnessInvocationSpec =>
  ({
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'codex', provider: 'openai', driver: 'codex-cli-tmux' },
    process: {
      command: '/opt/bin/codex',
      args: ['--', 'launch'],
      cwd: process.cwd(),
      lockedEnv: { OPENAI_API_KEY: 'test-key' },
      harnessTransport: { kind: 'pty' },
      limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 500 },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'codex-cli-tmux', terminalHost: 'tmux' },
    correlation: { hostSessionId: 'host-session-codex-driver', runtimeId: 'runtime-codex-driver' },
  }) as HarnessInvocationSpec

const loadFactory = async (): Promise<CodexCliTmuxDriverFactory> => {
  const target = (await import('../../../src/drivers/codex-cli-tmux/driver')) as {
    createCodexCliTmuxDriver?: CodexCliTmuxDriverFactory | undefined
  }
  if (target.createCodexCliTmuxDriver === undefined) {
    throw new Error('createCodexCliTmuxDriver export is required')
  }
  return target.createCodexCliTmuxDriver
}

const loadSocketPathBuilder = async (): Promise<
  (socketDir: string, context: { invocationId: string; runtimeId?: string | undefined }) => string
> => {
  const target = (await import('../../../src/drivers/codex-cli-tmux/driver')) as {
    buildCodexHookSocketPath?:
      | ((
          socketDir: string,
          context: { invocationId: string; runtimeId?: string | undefined }
        ) => string)
      | undefined
  }
  if (target.buildCodexHookSocketPath === undefined) {
    throw new Error('buildCodexHookSocketPath export is required')
  }
  return target.buildCodexHookSocketPath
}

const recordingExec = (calls: TmuxExecCall[]) => {
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ argv, env: options?.env })
    if (argv.includes('display-message')) return { stdout: '$9\t@4\t%42\n', stderr: '' }
    if (argv.includes('list-panes')) throw new Error("can't find session")
    if (argv.includes('new-session')) {
      return { stdout: '$1\t@1\t%7\thrc-host-sessio\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
}

const paneLease = (overrides: Partial<TerminalSurfaceLease> = {}): TerminalSurfaceLease => ({
  kind: 'tmux-pane',
  ownership: 'hrc',
  socketPath: '/tmp/harness-broker/codex-tmux.sock',
  sessionId: '$9',
  windowId: '@4',
  paneId: '%42',
  sessionName: 'hrc-owned-codex',
  windowName: 'main',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true },
  ...overrides,
})

const codexTmuxSpecWithIds = (nextInvocationId: string, runtimeId: string): HarnessInvocationSpec =>
  ({
    ...codexTmuxSpec(),
    invocationId: nextInvocationId,
    correlation: {
      hostSessionId: `host-${runtimeId}`,
      runtimeId,
    },
  }) as HarnessInvocationSpec

const createCtx = (
  events: InvocationEventEnvelope[],
  runtime?: { terminalSurface?: unknown; tmux?: { socketPath: string } } | undefined,
  ctxInvocationId = invocationId
): DriverContext =>
  ({
    invocationId: ctxInvocationId,
    clientCapabilities: {},
    ...(runtime !== undefined ? { runtime } : {}),
    emit(type, payload, extra) {
      const event = {
        invocationId: ctxInvocationId,
        seq: events.length + 1,
        time: now().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
  }) as DriverContext

const jsonl = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`
const agentMessage = (message: string): string =>
  jsonl({ type: 'event_msg', payload: { type: 'agent_message', message } })
const taskComplete = (last: string): string =>
  jsonl({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: last } })

const tmuxArgv = (calls: TmuxExecCall[]): string[][] => calls.map((call) => call.argv)

const pastedTexts = (calls: TmuxExecCall[]): string[] =>
  calls
    .map((call) => call.argv)
    .filter((argv) => argv.includes('set-buffer'))
    .map((argv) => argv.at(-1) ?? '')

function launchArtifact(calls: TmuxExecCall[]): LaunchArtifact {
  const launchCommand = pastedTexts(calls).find((text) =>
    text.includes('/tmp/harness-broker/codex-hooks.sock.codex.launch.json')
  )
  if (launchCommand === undefined) throw new Error('tmux launch artifact command was not pasted')
  const match = launchCommand.match(/\/tmp\/harness-broker\/codex-hooks\.sock\.codex\.launch\.json/)
  if (!match) throw new Error(`unable to parse launch artifact path from: ${launchCommand}`)
  return JSON.parse(readFileSync(match[0], 'utf8')) as LaunchArtifact
}

const expectNoForbiddenLifecycleCommands = (calls: TmuxExecCall[]): void => {
  const forbidden = [
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
  ]
  const flattened = tmuxArgv(calls).flat()
  for (const command of forbidden) {
    expect(flattened).not.toContain(command)
  }
}

const expectTargetedToPane = (calls: TmuxExecCall[], paneId: string): void => {
  for (const argv of tmuxArgv(calls)) {
    if (
      argv.includes('send-keys') ||
      argv.includes('set-buffer') ||
      argv.includes('paste-buffer') ||
      argv.includes('display-message')
    ) {
      expect(argv).toContain('-t')
      expect(argv).toContain(paneId)
    }
  }
}

describe('codex-cli-tmux driver: runtime pane lease', () => {
  test('advertises no live driver attach-to-existing-surface support distinct from operator attach', async () => {
    const createDriver = await loadFactory()
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/codex-tmux.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: recordingExec([]),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/codex-hooks.sock',
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

  test('runtime-scoped hook callback socket path is per invocation/runtime and stays under hooks dir', async () => {
    const buildSocketPath = await loadSocketPathBuilder()
    const hooksDir = '/tmp/praesidium/runtime/broker-ipc/runtime-a/hooks'
    const first = buildSocketPath(hooksDir, {
      invocationId: 'inv_codex_runtime_scope_first',
      runtimeId: 'runtime-codex-a',
    })
    const second = buildSocketPath(hooksDir, {
      invocationId: 'inv_codex_runtime_scope_second',
      runtimeId: 'runtime-codex-b',
    })

    // T-01794 Phase D: codex-cli-tmux must stop sharing the legacy global
    // /tmp/harness-broker/codex-hooks.sock between durable broker runtimes.
    expect(first).toStartWith(`${hooksDir}/`)
    expect(second).toStartWith(`${hooksDir}/`)
    expect(first).not.toBe('/tmp/harness-broker/codex-hooks.sock')
    expect(second).not.toBe('/tmp/harness-broker/codex-hooks.sock')
    expect(first).not.toBe(second)
    expect(first.split('/').at(-1)).toMatch(/^codex-hooks\.[0-9a-f]{16}\.sock$/)
    expect(second.split('/').at(-1)).toMatch(/^codex-hooks\.[0-9a-f]{16}\.sock$/)
  })

  test('rejects start when runtime terminalSurface is absent', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: recordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/codex-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await expect(driver.start(codexTmuxSpec(), createCtx([]))).rejects.toThrow(
      /runtime\.terminalSurface/i
    )
    expect(tmuxCalls).toEqual([])
  })

  test('rejects start when runtime terminalSurface is not an hrc tmux-pane lease', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: recordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/codex-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await expect(
      driver.start(
        codexTmuxSpec(),
        createCtx([], {
          terminalSurface: { ...paneLease(), kind: 'tmux-session', ownership: 'driver' } as never,
        })
      )
    ).rejects.toThrow(/hrc.*tmux-pane/i)
    expect(tmuxCalls).toEqual([])
  })

  test('rejects start when the leased pane cannot be inspected', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: async (argv, options) => {
          tmuxCalls.push({ argv, env: options?.env })
          if (argv.includes('display-message')) throw new Error("can't find pane: %42")
          return { stdout: '', stderr: '' }
        },
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/codex-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await expect(
      driver.start(codexTmuxSpec(), createCtx([], { terminalSurface: paneLease() }))
    ).rejects.toThrow(/can't find pane/)
    expect(tmuxArgv(tmuxCalls)).toContainEqual(
      expect.arrayContaining([
        '/opt/bin/tmux',
        '-S',
        '/tmp/harness-broker/codex-tmux.sock',
        'display-message',
        '-t',
        '%42',
      ])
    )
  })

  test('reports the leased tmux pane and never issues tmux lifecycle commands', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const events: InvocationEventEnvelope[] = []
    const lease = paneLease()
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: recordingExec(tmuxCalls),
      },
      hooks: {
        listen: async () => ({
          socketPath: '/tmp/harness-broker/codex-hooks.sock',
          close: async () => undefined,
        }),
      },
      now,
    })

    await driver.start(codexTmuxSpec(), createCtx(events, { terminalSurface: lease }))
    await driver.applyInputNow({
      inputId: 'input_codex_driver_1',
      kind: 'user',
      content: [{ type: 'text', text: 'continue $WITHOUT_EXPANSION' }],
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal.surface.reported',
        payload: {
          kind: 'tmux-pane',
          socketPath: lease.socketPath,
          sessionId: lease.sessionId,
          windowId: lease.windowId,
          paneId: lease.paneId,
          sessionName: lease.sessionName,
          windowName: lease.windowName,
        },
        driver: { kind: 'codex-cli-tmux', rawType: 'tmux.surface' },
      })
    )
    expectNoForbiddenLifecycleCommands(tmuxCalls)
    expectTargetedToPane(tmuxCalls, lease.paneId)
    expect(pastedTexts(tmuxCalls).some((text) => text.includes('/opt/bin/codex'))).toBe(false)
    const artifact = launchArtifact(tmuxCalls)
    expect(artifact.argv).toEqual(['/opt/bin/codex', '--', 'launch'])
    expect(artifact.env?.['OPENAI_API_KEY']).toBe('test-key')
    expect(artifact.env?.['HARNESS_BROKER_INVOCATION_ID']).toBe(invocationId)
    expect(artifact.env?.['HARNESS_BROKER_CALLBACK_SOCKET']).toBe(
      '/tmp/harness-broker/codex-hooks.sock'
    )
    // T-01798: the launch env must authoritatively stamp the invocation's
    // runtimeId so an inherited/leaked HARNESS_BROKER_RUNTIME_ID cannot poison
    // the hook envelope and trip the identity fence (which drops every hook).
    expect(artifact.env?.['HARNESS_BROKER_RUNTIME_ID']).toBe('runtime-codex-driver')
    expect(tmuxArgv(tmuxCalls)).toContainEqual([
      '/opt/bin/tmux',
      '-S',
      lease.socketPath,
      'send-keys',
      '-l',
      '-t',
      lease.paneId,
      'continue $WITHOUT_EXPANSION',
    ])
  })

  test('durable hook envelopes reject mismatched invocation/runtime/generation/socket identity', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const events: InvocationEventEnvelope[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<HookResult>) | undefined
    const hookSocket =
      '/tmp/praesidium/runtime/broker-ipc/runtime-codex/hooks/codex-hooks.live.sock'
    const liveInvocationId = 'inv_codex_identity_live'
    const liveRuntimeId = 'runtime-codex-identity-live'
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: recordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler
          return { socketPath: hookSocket, close: async () => undefined }
        },
      },
      now,
    })

    await driver.start(
      codexTmuxSpecWithIds(liveInvocationId, liveRuntimeId),
      createCtx(events, { terminalSurface: paneLease() }, liveInvocationId)
    )
    if (hookHandler === undefined) throw new Error('hook handler was not captured')

    const envelope = (overrides: Partial<HookEnvelope> = {}): HookEnvelope => ({
      invocationId: liveInvocationId,
      runtimeId: liveRuntimeId,
      generation: 1,
      callbackSocket: hookSocket,
      turnId: 'turn_codex_identity_1',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      ...overrides,
    })

    const baseline = events.length
    await hookHandler(envelope({ invocationId: 'inv_codex_identity_foreign' }))
    await hookHandler(envelope({ runtimeId: 'runtime-codex-identity-foreign' }))
    await hookHandler(envelope({ generation: 2 }))
    await hookHandler(envelope({ callbackSocket: `${hookSocket}.foreign` }))
    expect(events).toHaveLength(baseline)

    await hookHandler(envelope())
    expect(events.slice(baseline).map((event) => event.type)).toEqual([
      'turn.started',
      'user.message',
    ])
  })

  test('legacy hook envelope without durable generation is still accepted', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const events: InvocationEventEnvelope[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<HookResult>) | undefined
    const hookSocket = '/tmp/harness-broker/codex-hooks.sock'
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: recordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler
          return { socketPath: hookSocket, close: async () => undefined }
        },
      },
      now,
    })

    await driver.start(codexTmuxSpec(), createCtx(events, { terminalSurface: paneLease() }))
    if (hookHandler === undefined) throw new Error('hook handler was not captured')
    const baseline = events.length

    // T-01794 Phase D: strict generation checks only apply to durable identity
    // envelopes. Legacy stdio/callback rows that omit generation must continue
    // to flow.
    await hookHandler({
      invocationId,
      callbackSocket: hookSocket,
      turnId: 'turn_codex_legacy_generation_absent',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'legacy go' },
    })

    expect(events.slice(baseline).map((event) => event.type)).toEqual([
      'turn.started',
      'user.message',
    ])
  })

  test('mail Stop block suppresses terminal events until the composed gate clears', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const events: InvocationEventEnvelope[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<HookResult>) | undefined
    const hookSocket = '/tmp/harness-broker/codex-mail-stop.sock'
    const driver = createDriver({
      tmux: {
        socketPath: '/tmp/harness-broker/hidden-default-should-not-be-used.sock',
        tmuxBin: '/opt/bin/tmux',
        exec: recordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler
          return { socketPath: hookSocket, close: async () => undefined }
        },
      },
      now,
    })
    await driver.start(codexTmuxSpec(), createCtx(events, { terminalSurface: paneLease() }))
    if (hookHandler === undefined) throw new Error('hook handler was not captured')

    const base: HookEnvelope = {
      invocationId,
      runtimeId: 'runtime-codex-driver',
      generation: 1,
      callbackSocket: hookSocket,
      turnId: 'turn_codex_mail_stop',
      hookData: {
        hook_event_name: 'UserPromptSubmit',
        turn_id: 'turn_codex_mail_stop',
        prompt: 'finish after mail',
      },
    }
    await hookHandler(base)
    const stop: HookEnvelope = {
      ...base,
      hookData: {
        hook_event_name: 'Stop',
        turn_id: 'turn_codex_mail_stop',
        last_assistant_message: 'draft',
      },
    }

    expect(
      await hookHandler({
        ...stop,
        mailStopDecision: { decision: 'block', reason: 'Run hrcmail inbox.' },
      })
    ).toEqual({ decision: 'block', reason: 'Run hrcmail inbox.' })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)

    expect(await hookHandler(stop)).toBeUndefined()
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })
})

describe('codex-cli-tmux driver: hook-ordered transcript reading', () => {
  test('the transcript reader runs before hook normalization: terminal message precedes turn.completed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-driver-tx-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    writeFileSync(transcriptPath, '')
    try {
      const createDriver = await loadFactory()
      const tmuxCalls: TmuxExecCall[] = []
      let hookHandler: ((envelope: HookEnvelope) => Promise<HookResult>) | undefined
      const events: InvocationEventEnvelope[] = []
      const socketPath = '/tmp/harness-broker/codex-tmux.sock'
      const driver = createDriver({
        tmux: { socketPath, tmuxBin: '/opt/bin/tmux', exec: recordingExec(tmuxCalls) },
        hooks: {
          listen: async (handler) => {
            hookHandler = handler
            return {
              socketPath: '/tmp/harness-broker/codex-hooks.sock',
              close: async () => undefined,
            }
          },
        },
        now,
      })

      await driver.start(codexTmuxSpec(), createCtx(events, { terminalSurface: paneLease() }))
      expect(hookHandler).toBeDefined()

      const env = (hookData: unknown): HookEnvelope => ({
        invocationId,
        generation: 1,
        callbackSocket: '/tmp/harness-broker/codex-hooks.sock',
        turnId: 'turn_codex_driver_1',
        hookData,
      })

      await hookHandler?.(env({ hook_event_name: 'SessionStart', transcript_path: transcriptPath }))
      await hookHandler?.(
        env({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn_codex_driver_1', prompt: 'go' })
      )
      appendFileSync(transcriptPath, agentMessage('working on it'))
      await hookHandler?.(
        env({
          hook_event_name: 'PreToolUse',
          turn_id: 'turn_codex_driver_1',
          tool_use_id: 'call_1',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        })
      )
      await hookHandler?.(
        env({
          hook_event_name: 'PostToolUse',
          turn_id: 'turn_codex_driver_1',
          tool_use_id: 'call_1',
          tool_name: 'Bash',
          tool_response: { stdout: 'ok' },
        })
      )
      appendFileSync(transcriptPath, agentMessage('here is the answer'))
      appendFileSync(transcriptPath, taskComplete('here is the answer'))
      await hookHandler?.(
        env({
          hook_event_name: 'Stop',
          turn_id: 'turn_codex_driver_1',
          session_id: 'sess_1',
          last_assistant_message: 'here is the answer',
        })
      )

      const types = events.map((event) => event.type)
      const completed = events.filter((event) => event.type === 'assistant.message.completed')
      const finalCompleted = completed.filter((event) => event.payload['final'] === true)
      const interimCompleted = completed.filter((event) => event.payload['final'] === false)

      // Interim narration and exactly one terminal message.
      expect(interimCompleted.length).toBeGreaterThanOrEqual(1)
      expect(finalCompleted).toHaveLength(1)

      // Prose already present in the Codex transcript at PreToolUse is flushed
      // before the normalized tool.call.started event.
      const firstAssistantIdx = events.indexOf(completed[0] as InvocationEventEnvelope)
      const firstToolStartedIdx = types.indexOf('tool.call.started')
      expect(firstAssistantIdx).toBeGreaterThanOrEqual(0)
      expect(firstAssistantIdx).toBeLessThan(firstToolStartedIdx)

      // The reader runs BEFORE normalization: the terminal final:true message is
      // emitted before this turn's turn.completed.
      const finalIdx = types.indexOf(
        'assistant.message.completed',
        types.indexOf('tool.call.completed')
      )
      const turnCompletedIdx = types.indexOf('turn.completed')
      expect(finalCompleted[0]).toMatchObject({
        turnId: 'turn_codex_driver_1',
        payload: { content: [{ type: 'text', text: 'here is the answer' }], final: true },
      })
      const finalEventIdx = events.indexOf(finalCompleted[0] as InvocationEventEnvelope)
      expect(finalEventIdx).toBeLessThan(turnCompletedIdx)
      expect(finalIdx).toBeGreaterThanOrEqual(0)

      // No intermediate appears AFTER turn.completed.
      const intermediateAfterTerminal = interimCompleted.some(
        (event) => events.indexOf(event) > turnCompletedIdx
      )
      expect(intermediateAfterTerminal).toBe(false)

      await driver.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
