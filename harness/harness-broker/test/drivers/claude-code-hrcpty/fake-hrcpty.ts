import type { HrcptyConnect, HrcptyOpsConnection } from '../../../src/runtime/hrcpty'
import { HrcptyRpcError } from '../../../src/runtime/hrcpty'

export type FakeHrcptyCall = { method: string; params: Record<string, unknown> }

export type FakeClaudeScreen = {
  /** What Claude's input box holds. */
  box: string
  /** Bodies Claude took on `\r`. */
  submitted: string[]
  interrupts: number
  /** On an interrupt, put the last submitted prompt back in the box (§4.5). */
  restoreOnInterrupt: boolean
  /** Swallow this many `\r` before honouring one. */
  swallowEnters: number
  /** No input box drawn yet: Claude is still starting. */
  booting: boolean
  /**
   * A paste takes this long to show in the box, and a `\r` that arrives
   * before it does is dropped. Models a slow render, so a submit check that
   * reads the box too early cannot pass on an empty box.
   */
  pasteLagMs: number
  /** `\r` presses dropped while a paste was still rendering. */
  dropped?: number
}

export type FakeHrcpty = {
  connect: HrcptyConnect
  calls: FakeHrcptyCall[]
  screen: FakeClaudeScreen
  /** Every `input` frame decoded, in order. */
  inputs: () => string[]
  spawnParams: () => Record<string, unknown> | undefined
  tokens: string[]
}

const PASTE_OPEN = '\x1b[200~'
const PASTE_CLOSE = '\x1b[201~'

/**
 * An in-memory hrc-pty ops endpoint in front of a one-row model of Claude's
 * TUI: a header row and the `❯ ` input box, with the cursor after the box
 * text. `input` bytes are interpreted the way Claude treats them (bracketed
 * paste fills the box, `\r` submits, Ctrl-U clears); `interrupt` optionally
 * restores the last prompt into the box, as Claude does after an early
 * interrupt.
 */
export function createFakeHrcpty(
  options: {
    token?: string
    size?: { cols: number; rows: number }
    screen?: Partial<FakeClaudeScreen>
  } = {}
): FakeHrcpty {
  const token = options.token ?? 'tok-fake'
  const size = options.size ?? { cols: 100, rows: 30 }
  const calls: FakeHrcptyCall[] = []
  const tokens: string[] = []
  const screen: FakeClaudeScreen = {
    box: '',
    submitted: [],
    interrupts: 0,
    restoreOnInterrupt: false,
    swallowEnters: 0,
    booting: false,
    pasteLagMs: 0,
    ...options.screen,
  }
  let spawned = false
  let renderingPaste = false

  const rows = (): string[] =>
    screen.booting ? ['Claude Code starting'] : ['Claude Code', `❯ ${screen.box}`]

  const applyInput = (text: string): void => {
    let rest = text
    while (rest.length > 0) {
      if (rest.startsWith(PASTE_OPEN)) {
        const close = rest.indexOf(PASTE_CLOSE)
        const body = rest.slice(PASTE_OPEN.length, close === -1 ? undefined : close)
        const shown = body.includes('\n') ? '[Pasted text #1]' : body
        rest = close === -1 ? '' : rest.slice(close + PASTE_CLOSE.length)
        if (screen.pasteLagMs > 0) {
          renderingPaste = true
          setTimeout(() => {
            screen.box += shown
            renderingPaste = false
          }, screen.pasteLagMs)
        } else {
          screen.box += shown
        }
        continue
      }
      const ch = rest[0] as string
      rest = rest.slice(1)
      if (ch === '\r') {
        if (renderingPaste) {
          screen.dropped = (screen.dropped ?? 0) + 1
        } else if (screen.swallowEnters > 0) {
          screen.swallowEnters -= 1
        } else if (screen.box.length > 0) {
          screen.submitted.push(screen.box)
          screen.box = ''
        }
      } else if (ch === '\x15') {
        screen.box = ''
      } else {
        screen.box += ch
      }
    }
  }

  const handle = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case 'hello':
        tokens.push(String(params['token']))
        if (params['token'] !== token)
          throw new HrcptyRpcError(method, 'unauthorized', 'token mismatch')
        return {
          protocol: 'hrc-pty/1',
          pid: 4242,
          child: { pid: spawned ? 4243 : null, state: spawned ? 'running' : 'none' },
          size,
        }
      case 'spawn':
        if (spawned) throw new HrcptyRpcError(method, 'child_alive', 'a child is already running')
        spawned = true
        return { pid: 4243, cols: params['cols'] ?? size.cols, rows: params['rows'] ?? size.rows }
      case 'input':
        applyInput(Buffer.from(String(params['bytes']), 'base64').toString('utf8'))
        return { written: 1 }
      case 'interrupt':
        screen.interrupts += 1
        if (screen.restoreOnInterrupt) screen.box = screen.submitted.at(-1) ?? ''
        return { written: 1 }
      case 'capture': {
        const lines = rows()
        const y = lines.length - 1
        const x = screen.booting ? 0 : 2 + screen.box.length
        const text =
          params['styled'] === true
            ? `\x1b[3g\x1b[H${lines.join('\r\n')}\x1b[${y + 1};${x + 1}H\x1b[0m`
            : lines.join('\n')
        return { text, cursor: { x, y, visible: true }, ...size, screen: 'primary' }
      }
      case 'status':
        return { protocol: 'hrc-pty/1', pid: 4242, child: { pid: 4243, state: 'running' }, size }
      case 'resize':
        return { cols: params['cols'], rows: params['rows'] }
      default:
        throw new HrcptyRpcError(method, 'method_not_found', method)
    }
  }

  const connection: HrcptyOpsConnection = {
    async call(method, params = {}) {
      calls.push({ method, params })
      return handle(method, params)
    },
    close() {},
  }

  return {
    connect: async () => connection,
    calls,
    screen,
    tokens,
    inputs: () =>
      calls
        .filter((call) => call.method === 'input')
        .map((call) => Buffer.from(String(call.params['bytes']), 'base64').toString('utf8')),
    spawnParams: () => calls.find((call) => call.method === 'spawn')?.params,
  }
}

export function hrcptyLease(socketPath = '/tmp/bipc/rt/hrcpty.sock') {
  return {
    kind: 'hrcpty' as const,
    ownership: 'hrc' as const,
    socketPath,
    allowedOps: {
      inspect: true as const,
      sendInput: true as const,
      sendInterrupt: true as const,
      capture: true as const,
      spawn: true as const,
    },
  }
}
