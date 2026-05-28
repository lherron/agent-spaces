import { describe, expect, test } from 'bun:test'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../src/errors'
import { TmuxPaneController, createTmuxPaneController } from '../../src/runtime/tmux'
import type { TmuxPaneAllowedOps, TmuxPaneControllerLease } from '../../src/runtime/tmux'

type FakeExecCall = {
  argv: string[]
  env?: Record<string, string | undefined> | undefined
}

const ALLOWED_TMUX_VERBS = new Set([
  'capture-pane',
  'display-message',
  'paste-buffer',
  'send-keys',
  'set-buffer',
])

const FORBIDDEN_TMUX_VERBS = [
  'start-server',
  'kill-server',
  'new-session',
  'new-window',
  'split-window',
  'rename-session',
  'kill-session',
  'attach-session',
  'respawn-pane',
  'set-environment',
]

const baseLease: TmuxPaneControllerLease = {
  paneId: '%12',
  sessionId: '$3',
  windowId: '@7',
  allowedOps: {
    inspect: true,
    sendInput: true,
    sendInterrupt: true,
    capture: true,
    resize: true,
  },
}

function createRecordingController(allowedOps: TmuxPaneAllowedOps = baseLease.allowedOps): {
  controller: TmuxPaneController
  calls: FakeExecCall[]
} {
  const calls: FakeExecCall[] = []
  const controller = createTmuxPaneController({
    socketPath: '/tmp/harness-broker-tmux.sock',
    tmuxBin: '/opt/bin/tmux',
    lease: {
      ...baseLease,
      allowedOps,
    },
    exec: async (argv, options) => {
      calls.push({ argv, env: options?.env })
      const verb = argv.find((part) => ALLOWED_TMUX_VERBS.has(part))
      if (verb === 'display-message') {
        return { stdout: '$3\t@7\t%12\n', stderr: '' }
      }
      if (verb === 'capture-pane') {
        return { stdout: 'captured terminal text\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    },
  })

  return { controller, calls }
}

function tmuxVerbs(calls: FakeExecCall[]): string[] {
  return calls.map((call) => {
    const verb = call.argv.find(
      (part) => ALLOWED_TMUX_VERBS.has(part) || FORBIDDEN_TMUX_VERBS.includes(part)
    )
    if (!verb) {
      throw new Error(`no tmux verb found in argv: ${call.argv.join(' ')}`)
    }
    return verb
  })
}

describe('TmuxPaneController', () => {
  test('pane operations issue only capability-safe tmux verbs', async () => {
    const { controller, calls } = createRecordingController()

    await expect(controller.inspect()).resolves.toEqual({
      paneId: '%12',
      sessionId: '$3',
      windowId: '@7',
      alive: true,
    })
    await controller.sendLiteral('hello $USER')
    await controller.sendEnter()
    await controller.sendKeys('continue')
    await controller.sendPastedLine('very long command --with "$quoted args"')
    await controller.interrupt()
    await expect(controller.capture()).resolves.toBe('captured terminal text\n')
    await controller.resize({ columns: 120, rows: 40 })

    const verbs = tmuxVerbs(calls)
    expect(verbs.every((verb) => ALLOWED_TMUX_VERBS.has(verb))).toBe(true)
    for (const forbiddenVerb of FORBIDDEN_TMUX_VERBS) {
      expect(verbs).not.toContain(forbiddenVerb)
    }
    for (const argv of calls.map((call) => call.argv)) {
      if (
        argv.includes('display-message') ||
        argv.includes('send-keys') ||
        argv.includes('set-buffer') ||
        argv.includes('paste-buffer')
      ) {
        expect(argv).toContain('-t')
        expect(argv).toContain(baseLease.paneId)
      }
    }
  })

  test('capture is gated by allowedOps.capture', async () => {
    const { controller: deniedController, calls: deniedCalls } = createRecordingController({
      ...baseLease.allowedOps,
      capture: false,
    })

    await expect(deniedController.capture()).rejects.toMatchObject({
      code: BrokerErrorCode.CapabilityDenied,
      message: 'capture requires allowedOps.capture',
    })
    expect(deniedCalls).toEqual([])

    const { controller: allowedController } = createRecordingController()
    await expect(allowedController.capture()).resolves.toBe('captured terminal text\n')
  })

  test('resize is gated by allowedOps.resize', async () => {
    const { controller, calls } = createRecordingController({
      ...baseLease.allowedOps,
      resize: false,
    })

    await expect(controller.resize({ columns: 100, rows: 30 })).rejects.toMatchObject({
      code: BrokerErrorCode.CapabilityDenied,
      message: 'resize requires allowedOps.resize',
    })
    expect(calls).toEqual([])
  })

  test('constructor requires inspect, sendInput, and sendInterrupt capabilities', () => {
    for (const requiredCapability of ['inspect', 'sendInput', 'sendInterrupt'] as const) {
      expect(
        () =>
          new TmuxPaneController({
            socketPath: '/tmp/harness-broker-tmux.sock',
            lease: {
              ...baseLease,
              allowedOps: {
                ...baseLease.allowedOps,
                [requiredCapability]: false,
              },
            },
            exec: async () => ({ stdout: '', stderr: '' }),
          })
      ).toThrow(BrokerError)
    }
  })
})
