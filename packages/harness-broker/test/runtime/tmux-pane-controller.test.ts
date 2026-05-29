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
  // Stateful pane model so the confirm-then-submit path (T-01734) resolves
  // deterministically: capture-pane echoes the pasted command while it is still
  // sitting at the prompt, then reports the pane as advanced once Enter lands.
  let lastPasted = ''
  let awaitingSubmit = false
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
      if (verb === 'set-buffer') {
        lastPasted = argv[argv.length - 1] ?? ''
        awaitingSubmit = true
        return { stdout: '', stderr: '' }
      }
      if (argv.includes('send-keys') && argv.includes('Enter')) {
        awaitingSubmit = false
        return { stdout: '', stderr: '' }
      }
      if (verb === 'display-message') {
        return { stdout: '$3\t@7\t%12\n', stderr: '' }
      }
      if (verb === 'capture-pane') {
        // While a paste is awaiting submit the command still sits at the prompt;
        // otherwise the pane has advanced to ordinary terminal output.
        return {
          stdout: awaitingSubmit ? `${lastPasted}\n` : 'captured terminal text\n',
          stderr: '',
        }
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

  test('re-presses Enter while the pasted command stays unexecuted, then stops once it advances', async () => {
    // T-01734: a contended/slow shell can swallow the first Enter, leaving the
    // launch command at the prompt. The driver must re-submit until the line
    // advances — and must NOT keep pressing Enter once it has.
    let enters = 0
    let lastPasted = ''
    const controller = createTmuxPaneController({
      socketPath: '/tmp/harness-broker-tmux.sock',
      tmuxBin: '/opt/bin/tmux',
      lease: { ...baseLease },
      exec: async (argv) => {
        const verb = argv.find((part) => ALLOWED_TMUX_VERBS.has(part))
        if (verb === 'set-buffer') {
          lastPasted = argv[argv.length - 1] ?? ''
          return { stdout: '', stderr: '' }
        }
        if (argv.includes('send-keys') && argv.includes('Enter')) {
          enters += 1
          return { stdout: '', stderr: '' }
        }
        if (verb === 'capture-pane') {
          // The first Enter is "lost"; only after the second does the pane advance.
          return { stdout: enters >= 2 ? 'prompt advanced $\n' : `${lastPasted}\n`, stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
    })

    await controller.sendPastedLine('CODEX_HOME=/tmp codex --foo bar')
    expect(enters).toBe(2)
  })

  test('matches a pasted command that capture-pane hard-wraps across lines', async () => {
    // T-01747: capture-pane hard-wraps a long pasted command at the pane width with
    // a newline the command never had. The present-check must still recognise the
    // command (collapsing wrap-newlines to a SPACE used to break the tail match and
    // burn the full present-timeout). Here the command is wrapped INSIDE the tail
    // window; the controller must confirm-present on the first paste (no re-paste).
    let pasteCount = 0
    let ctrlCs = 0
    let enters = 0
    let submitted = false
    const cmd =
      'exec bun /Users/x/praesidium/agent-spaces/packages/harness-broker/src/runtime/tmux-launch-runner.ts --launch-file /tmp/harness-broker/codex-hooks.sock.codex.launch.json'
    const wrapped = cmd.replace(/(.{40})/g, '$1\n')
    const controller = createTmuxPaneController({
      socketPath: '/tmp/harness-broker-tmux.sock',
      tmuxBin: '/opt/bin/tmux',
      lease: { ...baseLease },
      exec: async (argv) => {
        const verb = argv.find((part) => ALLOWED_TMUX_VERBS.has(part))
        if (verb === 'paste-buffer') {
          pasteCount += 1
          return { stdout: '', stderr: '' }
        }
        if (argv.includes('send-keys') && argv.includes('C-c')) {
          ctrlCs += 1
          return { stdout: '', stderr: '' }
        }
        if (argv.includes('send-keys') && argv.includes('Enter')) {
          enters += 1
          submitted = true
          return { stdout: '', stderr: '' }
        }
        if (verb === 'capture-pane') {
          return { stdout: submitted ? 'prompt advanced $\n' : `max3 ~ ❯ ${wrapped}\n`, stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
    })

    await controller.sendPastedLine(cmd)
    expect(pasteCount).toBe(1)
    expect(ctrlCs).toBe(0)
    expect(enters).toBe(1)
  })

  test('re-pastes after a dropped paste, discarding the partial with C-c first', async () => {
    // T-01747: paste-buffer is silently DROPPED if the leased pane's shell PTY is
    // not yet reading on a cold launch. The controller must re-paste (after a C-c
    // to discard any partial, so the re-paste does not concatenate) until the
    // command renders — replacing the codex driver's blind pre-paste sleep and the
    // bare-shell pane a dropped paste used to leave behind.
    let pasteCount = 0
    let ctrlCs = 0
    let enters = 0
    let submitted = false
    let lastPasted = ''
    const controller = createTmuxPaneController({
      socketPath: '/tmp/harness-broker-tmux.sock',
      tmuxBin: '/opt/bin/tmux',
      lease: { ...baseLease },
      exec: async (argv) => {
        const verb = argv.find((part) => ALLOWED_TMUX_VERBS.has(part))
        if (verb === 'set-buffer') {
          lastPasted = argv[argv.length - 1] ?? ''
          return { stdout: '', stderr: '' }
        }
        if (verb === 'paste-buffer') {
          pasteCount += 1
          return { stdout: '', stderr: '' }
        }
        if (argv.includes('send-keys') && argv.includes('C-c')) {
          ctrlCs += 1
          return { stdout: '', stderr: '' }
        }
        if (argv.includes('send-keys') && argv.includes('Enter')) {
          enters += 1
          submitted = true
          return { stdout: '', stderr: '' }
        }
        if (verb === 'capture-pane') {
          // First paste is dropped → only the bare prompt shows; the command renders
          // only after the second paste lands.
          if (pasteCount < 2) {
            return { stdout: 'max3 ~ ❯ \n', stderr: '' }
          }
          return { stdout: submitted ? 'prompt advanced $\n' : `${lastPasted}\n`, stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
    })

    await controller.sendPastedLine('CODEX_HOME=/tmp codex --foo bar')
    expect(pasteCount).toBeGreaterThanOrEqual(2)
    expect(ctrlCs).toBeGreaterThanOrEqual(1)
    expect(enters).toBe(1)
  })

  test('degrades to a single blind Enter when capture is not leased', async () => {
    // Without capture the pane cannot be observed, so the deterministic confirm
    // is impossible; fall back to the legacy gap + single Enter (no capture-pane).
    let enters = 0
    let captures = 0
    const controller = createTmuxPaneController({
      socketPath: '/tmp/harness-broker-tmux.sock',
      tmuxBin: '/opt/bin/tmux',
      lease: {
        ...baseLease,
        allowedOps: { inspect: true, sendInput: true, sendInterrupt: true, capture: false },
      },
      exec: async (argv) => {
        const verb = argv.find((part) => ALLOWED_TMUX_VERBS.has(part))
        if (verb === 'capture-pane') {
          captures += 1
        }
        if (argv.includes('send-keys') && argv.includes('Enter')) {
          enters += 1
        }
        return { stdout: '', stderr: '' }
      },
    })

    await controller.sendPastedLine('CODEX_HOME=/tmp codex')
    expect(enters).toBe(1)
    expect(captures).toBe(0)
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
