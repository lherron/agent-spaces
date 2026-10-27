import { afterEach, describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { inputIdFrom } from '../../ids'
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
  removeTempHookDirs,
  tempHookSocketPath,
  tmuxArgv,
} from './driver-red.helpers'

afterEach(removeTempHookDirs)

/** Fake hook listener whose socket lives in a per-test temp dir. */
const tempHooks = () => {
  const socketPath = tempHookSocketPath()
  return {
    listen: async () => ({ socketPath, close: async () => undefined }),
  }
}

describe('claude-code-tmux driver RED lifecycle', () => {
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

  test('start validates the leased pane, reports it as terminal.surface.reported, and targets only that pane with no lifecycle verbs', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const hookSocket = tempHookSocketPath()
    const decoySocket = '/tmp/harness-broker/hidden-default-should-not-be-used.sock'
    const driver = createDriver({
      tmux: {
        socketPath: decoySocket,
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return { socketPath: hookSocket, close: async () => undefined }
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
    // The construction-time tmux socket is never used: the driver attaches to
    // the leased socket.
    expect(tmuxArgv(tmuxCalls).every((argv) => !argv.includes(decoySocket))).toBe(true)
    expect(
      tmuxArgv(tmuxCalls).some((argv) => argv.includes('-S') && argv.includes(DEFAULT_LEASE_SOCKET))
    ).toBe(true)
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
      hooks: tempHooks(),
      now,
    })
    const events: InvocationEventEnvelope[] = []
    await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))

    const prompt = `T05577_BEGIN\n${'x'.repeat(100 * 1024)}\nT05577_END`
    await driver.applyInputNow({
      inputId: inputIdFrom('input_apply_1'),
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
      hooks: tempHooks(),
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

  test('start without a terminalSurface lease rejects naming terminalSurface and runs no tmux command', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: tempHooks(),
      now,
    })

    await expect(driver.start(claudeTmuxSpec(), createCtx([]))).rejects.toThrow(/terminalSurface/i)
    expect(tmuxCalls).toEqual([])
  })

  test.each([
    { leasedPane: 'not found by display-message', createExec: createNotFoundExec },
    {
      leasedPane: 'reported with ids that disagree with the lease',
      createExec: createMismatchingExec,
    },
  ])(
    'start rejects and sends no keys when the leased pane is $leasedPane',
    async ({ createExec }) => {
      const createDriver = await loadFactory()
      const tmuxCalls: TmuxExecCall[] = []
      const driver = createDriver({
        tmux: {
          tmuxBin: '/opt/bin/tmux',
          exec: createExec(tmuxCalls),
        },
        hooks: tempHooks(),
        now,
      })

      await expect(
        driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))
      ).rejects.toThrow(/leased pane not found or id mismatch/i)
      // Inspect was attempted, but no send-keys / launch ever happened.
      expect(tmuxCalls.some((call) => call.argv.includes('display-message'))).toBe(true)
      expect(tmuxCalls.every((call) => !call.argv.includes('send-keys'))).toBe(true)
    }
  )

  test('dispose releases driver resources without killing the tmux session or server', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    const driver = createDriver({
      tmux: {
        tmuxBin: '/opt/bin/tmux',
        exec: createRecordingExec(tmuxCalls),
      },
      hooks: tempHooks(),
      now,
    })
    await driver.start(claudeTmuxSpec(), createCtx([], { terminalSurface: defaultLease() }))

    await driver.dispose()

    expectNoForbiddenLifecycleVerbs(tmuxCalls)
  })
})
