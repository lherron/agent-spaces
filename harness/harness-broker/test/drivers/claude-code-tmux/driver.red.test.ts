import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { HookEnvelope, TmuxExecCall } from './driver-red.helpers'
import {
  DEFAULT_LEASE_PANE,
  DEFAULT_LEASE_SESSION,
  DEFAULT_LEASE_SESSION_NAME,
  DEFAULT_LEASE_SOCKET,
  DEFAULT_LEASE_WINDOW,
  claudeTmuxSpec,
  createCtx,
  createMismatchingExec,
  createNotFoundExec,
  createRecordingExec,
  defaultLease,
  expectNoForbiddenLifecycleVerbs,
  expectTargetsLeasedPane,
  loadFactory,
  loadSocketPathBuilder,
  now,
  tmuxArgv,
} from './driver-red.helpers'

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

  test('applyInputNow loads user text from a file, pastes it, and presses Enter', async () => {
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

    const prompt = `T05577_BEGIN\n${'x'.repeat(100 * 1024)}\nT05577_END`
    await driver.applyInputNow({
      inputId: 'input_apply_1',
      kind: 'user',
      content: [{ type: 'text', text: prompt }],
    })

    const inputLoad = tmuxCalls.find((call) => call.loadedText === prompt)
    expect(inputLoad?.argv).toContain('load-buffer')
    expect(tmuxCalls.flatMap((call) => call.argv)).not.toContain(prompt)
    expect(tmuxCalls.some((call) => call.argv.includes('set-buffer'))).toBe(false)
    expect(
      tmuxCalls.some(
        (call) =>
          call.argv.includes('paste-buffer') &&
          call.argv.includes('-d') &&
          call.argv.includes(DEFAULT_LEASE_PANE)
      )
    ).toBe(true)
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
