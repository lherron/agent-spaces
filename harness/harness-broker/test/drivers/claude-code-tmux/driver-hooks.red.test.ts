import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../../../src/drivers/driver'
import type { HookEnvelope, HookListenerMeta, TmuxExecCall } from './driver-red.helpers'
import {
  DEFAULT_LEASE_PANE,
  DEFAULT_LEASE_SOCKET,
  claudeTmuxSpec,
  createCtx,
  createRecordingExec,
  defaultLease,
  launchArtifact,
  loadFactory,
  now,
  pastedTexts,
  specWithIds,
  tmuxArgv,
} from './driver-red.helpers'

describe('claude-code-tmux driver RED lifecycle', () => {
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

    // Since T-07873 the tool call and the prompt text come from the session
    // JSONL, not from the hooks. This harness feeds hooks only (no transcript
    // file), so what remains is exactly the hook-owned bracket plus the
    // idle-path submission disposition.
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['turn.started', 'turn.completed'])
    )
    expect(
      events.filter((event) => event.turnId === 'turn_driver_envelope_1').map((event) => event.type)
    ).toEqual(['turn.started', 'submission.executed', 'turn.completed'])
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
      'submission.executed',
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
    // paste-confirm-submit path (load-buffer + paste-buffer), NOT a blind
    // send-keys -l. The command runs the real launch-runner module against the
    // JSON launch artifact written beside the hook socket.
    const launchLoadBuffer = tmuxCalls.find(
      (call) =>
        call.argv.includes('load-buffer') && (call.loadedText ?? '').includes('tmux-launch-runner')
    )
    expect(launchLoadBuffer?.loadedText).toMatch(
      /^exec bun \S*tmux-launch-runner\.(ts|js) --launch-file \/tmp\/harness-broker\/claude-hooks\.sock\.claude\.launch\.json$/
    )
    expect(launchLoadBuffer?.argv.some((arg) => arg.includes('tmux-launch-runner'))).toBe(false)
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
        // T-04846: hook-observed starts carry provenance (vs broker-delivery).
        payload: expect.objectContaining({ turnId: activeTurnId, source: 'hook-observed' }),
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
