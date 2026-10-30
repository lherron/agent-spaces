import { readFile } from 'node:fs/promises'
import { type Socket, connect } from 'node:net'
import { dirname, join } from 'node:path'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'
import {
  type TmuxPaneInputSelector,
  type TmuxPaneInputSnapshot,
  TmuxPaneNotQuiescentError,
  type TmuxSteerOptions,
} from './tmux'

/**
 * Broker side of hrc-pty's ops socket (T-12046 §4.2): JSON-RPC 2.0 over NDJSON
 * on `hrcpty.sock`, gated by `hello` with the runtime's attach token. hrc-pty
 * owns the pty and Claude as their real parent; the driver only spawns into it,
 * writes bytes and reads the headless VT model back through `capture`.
 */
export const HRCPTY_PROTOCOL = 'hrc-pty/1'

export type HrcptyAllowedOps = {
  inspect?: boolean | undefined
  sendInput?: boolean | undefined
  sendInterrupt?: boolean | undefined
  capture?: boolean | undefined
  resize?: boolean | undefined
  spawn?: boolean | undefined
}

export type HrcptyChildState = {
  pid: number | null
  state: 'none' | 'running' | 'exited'
  code?: number | null | undefined
  signal?: number | null | undefined
}

export type HrcptyHello = {
  capabilities?: string[] | undefined
  protocol: string
  pid: number
  child: HrcptyChildState
  size: { cols: number; rows: number }
}

export type HrcptyCapture = {
  text: string
  cursor: { x: number; y: number; visible?: boolean | undefined }
  cols: number
  rows: number
  screen: 'primary' | 'alternate'
}

export type HrcptySpawnRequest = {
  argv: string[]
  /** The child's complete environment; hrc-pty applies §4.2's TERM rules on top. */
  env: Record<string, string>
  cwd: string
  cols?: number | undefined
  rows?: number | undefined
}

/** An error frame from hrc-pty; `code` is its stable code (`child_alive`, `terminfo_missing`, …). */
export class HrcptyRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    message: string
  ) {
    super(`hrc-pty ${method}: ${message}`)
    this.name = 'HrcptyRpcError'
  }
}

/** One control connection. Calls may overlap; replies are matched by id. */
export interface HrcptyOpsConnection {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Receive id-less frames: what an `events` connection pushes after its reply. */
  onNotification?(handler: (method: string, params: Record<string, unknown>) => void): void
  /** Called once when the connection ends, for any reason. */
  onClose?(handler: () => void): void
  close(): void
}

/** One push frame from an `events` subscription (§4.2 step 2). */
export type HrcptyEvent =
  | {
      method: 'client.attached' | 'client.detached'
      params: { attachId: string; readOnly: boolean }
    }
  | {
      method: 'child.exited' | 'broker.exited'
      params: { pid: number; code: number | null; signal: number | null }
    }
  | { method: string; params: Record<string, unknown> }

export type HrcptyEventSubscription = { close(): void }

export type HrcptyConnect = (socketPath: string) => Promise<HrcptyOpsConnection>

export const connectHrcptyOps: HrcptyConnect = (socketPath) =>
  new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(createNdjsonConnection(socket))
    })
  })

type PendingCall = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function createNdjsonConnection(socket: Socket): HrcptyOpsConnection {
  const pending = new Map<number, PendingCall>()
  let nextId = 1
  let buffered = ''
  let closedError: Error | undefined
  let notify: ((method: string, params: Record<string, unknown>) => void) | undefined
  let closeHandler: (() => void) | undefined

  const failAll = (error: Error): void => {
    const first = closedError === undefined
    closedError ??= error
    for (const call of pending.values()) call.reject(closedError)
    pending.clear()
    if (first) closeHandler?.()
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffered += chunk
    for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line.length === 0) continue
      let frame: {
        id?: unknown
        method?: unknown
        params?: unknown
        result?: unknown
        error?: { message?: unknown; data?: unknown }
      }
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame.id === undefined && typeof frame.method === 'string') {
        const params =
          typeof frame.params === 'object' && frame.params !== null
            ? (frame.params as Record<string, unknown>)
            : {}
        notify?.(frame.method, params)
        continue
      }
      if (typeof frame.id !== 'number') continue
      const call = pending.get(frame.id)
      if (call === undefined) continue
      pending.delete(frame.id)
      if (frame.error !== undefined) {
        const message = typeof frame.error.message === 'string' ? frame.error.message : 'error'
        const data = frame.error.data as { code?: unknown } | undefined
        const code = typeof data?.code === 'string' ? data.code : 'error'
        call.reject(new HrcptyRpcError(call.method, code, message))
      } else {
        call.resolve(frame.result)
      }
    }
  })
  socket.on('error', (error) => failAll(error))
  socket.on('close', () => failAll(new Error('hrc-pty closed the control connection')))

  return {
    call(method, params = {}) {
      if (closedError !== undefined) return Promise.reject(closedError)
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject })
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    onNotification(handler) {
      notify = handler
    },
    onClose(handler) {
      closeHandler = handler
    },
    close() {
      failAll(new Error('hrc-pty control connection closed'))
      socket.destroy()
    },
  }
}

/** hrc-pty's own default (`serve --token-file`): `attach.token` beside the socket. */
export function defaultHrcptyTokenFile(socketPath: string): string {
  return join(dirname(socketPath), 'attach.token')
}

export type HrcptyPtyControllerOptions = {
  socketPath: string
  allowedOps: HrcptyAllowedOps
  /** The attach token `hello` presents; defaults to {@link defaultHrcptyTokenFile}. */
  token?: (() => Promise<string>) | undefined
  connect?: HrcptyConnect | undefined
  /** How long a write waits for the human before it is written anyway. */
  humanWindowBudgetMs?: number | undefined
}

/** Evidence from one bracketed submit, mirroring tmux's pasted-line delivery. */
export type HrcptyPastedLineDelivery = {
  confirmed: boolean
  submit: { attempts: number; durationMs: number }
}

export type HrcptyPastedLineOptions = {
  selectInput: TmuxPaneInputSelector
  submitTimeoutMs?: number | undefined
  pollIntervalMs?: number | undefined
}

export type HrcptyClearInputOptions = {
  /** Wait until this time (epoch ms) for Claude to put an interrupted prompt back. */
  restoreDeadline?: number | undefined
  pollIntervalMs?: number | undefined
}

const BRACKET_OPEN = '\x1b[200~'
const BRACKET_CLOSE = '\x1b[201~'
const CTRL_U = '\x15'
// §4.5: the `\r` may follow the paste in the same write or ~100-300 ms later.
const PASTE_SUBMIT_GAP_MS = 150
// A paste written while Claude is still starting renders when it is ready.
const PASTE_RENDER_TIMEOUT_MS = 10_000
const SUBMIT_CONFIRM_TIMEOUT_MS = 1_500
// tmux's submit budget: five Enters, 1.5 s apart, while the box holds the paste.
const MAX_SUBMIT_ATTEMPTS = 5
const POLL_INTERVAL_MS = 100
// Past this hold the body is written anyway: a mail held forever behind a
// draft is worse than one appended to it (fail open, Lance 2026-10-30). It
// outlasts DRAFT_IDLE_MS, so a draft left mid-hold still reaches the override.
const HUMAN_WINDOW_BUDGET_MS = 90_000
const HUMAN_IDLE_MS = 3_000
const DRAFT_IDLE_MS = 30_000
const HUMAN_WINDOW_POLL_MS = 250
const STEER_QUIESCENCE_TIMEOUT_MS = 5_000
const STEER_QUIESCENCE_POLL_INTERVAL_MS = 250
const STEER_LANDING_TIMEOUT_MS = 1_500
const STEER_LANDING_POLL_INTERVAL_MS = 150
// One Ctrl-U clears one editor line; a restored multi-line prompt takes several.
const MAX_CLEAR_ATTEMPTS = 8
const CLEAR_CONFIRM_TIMEOUT_MS = 1_500
const CLEAR_SETTLE_MS = 300

const NAMED_KEYS: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  'C-u': CTRL_U,
}

/**
 * The driver-facing controller over one hrc-pty ops socket, with the method
 * names `TmuxPaneController` gives the tmux drivers. Capability gates come
 * from the lease's `allowedOps`, exactly as for a pane lease.
 *
 * There is no shell and no paste buffer on this route: `spawn` starts the
 * harness directly, and `input` writes bytes to the pty master unchanged, so
 * nothing drops a paste and tmux's re-paste loop has no counterpart. What
 * stays is reading the input row back to confirm a submit and to wait for a
 * quiet box.
 */
export class HrcptyPtyController {
  readonly socketPath: string
  readonly humanWindowBudgetMs: number
  private readonly allowedOps: HrcptyAllowedOps
  private readonly token: () => Promise<string>
  private readonly connectImpl: HrcptyConnect
  private connection: Promise<{ connection: HrcptyOpsConnection; hello: HrcptyHello }> | undefined
  private closed = false

  constructor(options: HrcptyPtyControllerOptions) {
    this.socketPath = options.socketPath
    this.allowedOps = options.allowedOps
    this.humanWindowBudgetMs = options.humanWindowBudgetMs ?? HUMAN_WINDOW_BUDGET_MS
    this.connectImpl = options.connect ?? connectHrcptyOps
    this.token =
      options.token ??
      (async () => (await readFile(defaultHrcptyTokenFile(options.socketPath), 'utf8')).trim())

    for (const op of ['inspect', 'sendInput', 'sendInterrupt', 'spawn'] as const) {
      if (this.allowedOps[op] !== true) {
        throw new BrokerError(BrokerErrorCode.CapabilityDenied, `${op} requires allowedOps.${op}`)
      }
    }
  }

  /** Open (or reuse) the control connection; returns the `hello` it opened with. */
  async hello(): Promise<HrcptyHello> {
    const { hello } = await this.openConnection()
    return hello
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.call('status')) as Record<string, unknown>
  }

  async spawn(request: HrcptySpawnRequest): Promise<{ pid: number; cols: number; rows: number }> {
    return (await this.call('spawn', {
      argv: request.argv,
      env: request.env,
      cwd: request.cwd,
      ...(request.cols !== undefined ? { cols: request.cols } : {}),
      ...(request.rows !== undefined ? { rows: request.rows } : {}),
    })) as { pid: number; cols: number; rows: number }
  }

  /** Signal the pty child (`TERM`, `HUP`, `KILL`, `INT`); `no_child` when none runs. */
  async signal(signal: 'TERM' | 'HUP' | 'KILL' | 'INT'): Promise<void> {
    await this.call('signal', { signal })
  }

  /**
   * Hold an `events` subscription on its own connection: hrc-pty answers the
   * call once, then pushes `child.exited`, `broker.exited`, `client.attached`
   * and `client.detached` until the connection closes. `onClose` fires once
   * when it does, whoever closed it.
   */
  async subscribeEvents(
    onEvent: (event: HrcptyEvent) => void,
    onClose?: (() => void) | undefined
  ): Promise<HrcptyEventSubscription> {
    if (this.closed) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'hrc-pty controller is closed')
    }
    const connection = await this.connectImpl(this.socketPath)
    if (connection.onNotification === undefined) {
      connection.close()
      throw new BrokerError(
        BrokerErrorCode.CapabilityDenied,
        'hrc-pty connection cannot carry an events subscription'
      )
    }
    try {
      await connection.call('hello', { token: await this.token() })
      connection.onNotification((method, params) => onEvent({ method, params } as HrcptyEvent))
      if (onClose !== undefined) connection.onClose?.(onClose)
      await connection.call('events')
    } catch (error) {
      connection.close()
      throw error
    }
    return { close: () => connection.close() }
  }

  async sendLiteral(text: string): Promise<void> {
    if (text.length === 0) return
    await this.write(text)
  }

  async sendEnter(): Promise<void> {
    await this.write('\r')
  }

  /**
   * Submit one prompt with §4.5's encoding: the text as a single bracketed
   * paste, then `\r`. The input row is read back on both sides of the `\r`.
   * The `\r` waits until the paste shows in the box, because the submit is
   * judged against that state: read before the paste renders, an empty box
   * would pass for a submit Claude never took. After the `\r`, an emptied box means
   * Claude took it; a box still showing exactly the pasted state means the
   * `\r` was dropped, so it is pressed again; any other unemptied state is
   * `after_submit`, since the body may already be in the harness.
   */
  async sendPastedLine(
    text: string,
    options: HrcptyPastedLineOptions
  ): Promise<HrcptyPastedLineDelivery> {
    this.requireCapture()
    const intervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    if ((await this.hello()).capabilities?.includes('inputIfIdle')) {
      await this.writeInHumanWindow(bracketedPaste(text), options.selectInput)
    } else {
      await this.write(bracketedPaste(text))
    }
    const pasted = await this.waitForInput(
      (input) => !input.empty,
      options.selectInput,
      PASTE_RENDER_TIMEOUT_MS,
      intervalMs
    )
    if (!pasted.matched) throw new TmuxPaneNotQuiescentError('after_submit')
    const pastedFingerprint = pasted.last?.fingerprint
    // §4.5: a short gap between the paste and its `\r` is accepted either way.
    await sleep(PASTE_SUBMIT_GAP_MS)
    const startedAt = performance.now()
    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      await this.sendEnter()
      const state = await this.waitForInput(
        (input) => input.empty,
        options.selectInput,
        options.submitTimeoutMs ?? SUBMIT_CONFIRM_TIMEOUT_MS,
        intervalMs
      )
      if (state.matched) {
        return { confirmed: true, submit: { attempts: attempt, durationMs: elapsed(startedAt) } }
      }
      if (state.last?.fingerprint !== pastedFingerprint) break
    }
    throw new TmuxPaneNotQuiescentError('after_submit')
  }

  /**
   * Guard a live-turn steer on human idle time, then write paste plus `\r`
   * atomically and confirm the row clears. Older supervisors retain the
   * two-identical-empty-observations guard.
   */
  async sendSteer(text: string, options: TmuxSteerOptions): Promise<void> {
    if (this.allowedOps.capture !== true) {
      throw new TmuxPaneNotQuiescentError('before_paste')
    }
    if ((await this.hello()).capabilities?.includes('inputIfIdle')) {
      await this.writeInHumanWindow(`${bracketedPaste(text)}\r`, options.selectInput)
    } else {
      const quiescent = await this.waitForQuiescentInput(
        options.selectInput,
        options.quiescenceTimeoutMs ?? STEER_QUIESCENCE_TIMEOUT_MS,
        options.quiescencePollIntervalMs ?? STEER_QUIESCENCE_POLL_INTERVAL_MS
      )
      if (!quiescent) throw new TmuxPaneNotQuiescentError('before_paste')
      await this.write(`${bracketedPaste(text)}\r`)
    }
    const landed = await this.waitForInput(
      (input) => input.empty,
      options.selectInput,
      options.landingTimeoutMs ?? STEER_LANDING_TIMEOUT_MS,
      options.landingPollIntervalMs ?? STEER_LANDING_POLL_INTERVAL_MS
    )
    if (!landed.matched) {
      throw new TmuxPaneNotQuiescentError('after_submit')
    }
  }

  /**
   * Keystrokes own the window; a stale draft may be submitted after 30 s.
   * Resolves the `ifIdleMs` condition for the write, or `undefined` once the
   * budget is spent: the write then goes in unconditionally.
   */
  async awaitHumanWindow(
    selectInput: TmuxPaneInputSelector,
    budgetMs: number
  ): Promise<number | undefined> {
    const deadline = performance.now() + budgetMs
    for (;;) {
      const status = await this.status()
      const idle = status['humanIdleMs']
      if (typeof idle === 'number' && idle >= DRAFT_IDLE_MS) return DRAFT_IDLE_MS
      if (idle === null || (typeof idle === 'number' && idle >= HUMAN_IDLE_MS)) {
        const snapshot = await this.captureInputSnapshot()
        if (snapshot !== undefined && selectInput(snapshot).empty) return HUMAN_IDLE_MS
      }
      const remaining = deadline - performance.now()
      if (remaining <= 0) return undefined
      await sleep(Math.min(HUMAN_WINDOW_POLL_MS, remaining))
    }
  }

  private async writeInHumanWindow(
    text: string,
    selectInput: TmuxPaneInputSelector
  ): Promise<void> {
    const deadline = performance.now() + this.humanWindowBudgetMs
    for (;;) {
      const ifIdleMs = await this.awaitHumanWindow(
        selectInput,
        Math.max(0, deadline - performance.now())
      )
      const result = await this.write(text, ifIdleMs)
      if (result.written !== 0) return
      await sleep(Math.min(HUMAN_WINDOW_POLL_MS, Math.max(0, deadline - performance.now())))
    }
  }

  /**
   * Wait until the harness is up and reading: an empty box, or, on an
   * `inputIfIdle` supervisor, a prompt row holding a draft a human typed. The
   * human window then decides when the body may follow that draft.
   */
  async waitForInputReady(
    selectInput: TmuxPaneInputSelector,
    timeoutMs: number,
    intervalMs = POLL_INTERVAL_MS
  ): Promise<boolean> {
    this.requireCapture()
    const draftCounts = (await this.hello()).capabilities?.includes('inputIfIdle') === true
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const snapshot = await this.captureInputSnapshot()
      const input = snapshot === undefined ? undefined : selectInput(snapshot)
      if (input?.empty) return true
      if (draftCounts && input?.prompt === true && (await this.status())['humanIdleMs'] != null)
        return true
      if (Date.now() >= deadline) return false
      await sleep(intervalMs)
    }
  }

  /**
   * §4.5's clearing step after an interrupt: Claude puts the interrupted prompt
   * back in the box, and the next paste would append to it. Wait (until
   * `restoreDeadline`) for the box to fill, then Ctrl-U until it reads empty
   * and stays empty. A box that never fills means nothing was restored. A box
   * that will not clear refuses before any body is written.
   */
  async clearRestoredInput(
    selectInput: TmuxPaneInputSelector,
    options: HrcptyClearInputOptions = {}
  ): Promise<{ restored: boolean; ctrlU: number }> {
    this.requireCapture()
    const intervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    const restoreWaitMs = Math.max(0, (options.restoreDeadline ?? Date.now()) - Date.now())
    const restored = await this.waitForInput(
      (input) => !input.empty,
      selectInput,
      restoreWaitMs,
      intervalMs
    )
    if (!restored.matched) return { restored: false, ctrlU: 0 }
    for (let attempt = 1; attempt <= MAX_CLEAR_ATTEMPTS; attempt++) {
      await this.write(CTRL_U)
      const empty = await this.waitForInput(
        (input) => input.empty,
        selectInput,
        CLEAR_CONFIRM_TIMEOUT_MS,
        intervalMs
      )
      if (!empty.matched) continue
      await sleep(CLEAR_SETTLE_MS)
      const settled = await this.captureInputSnapshot()
      if (settled !== undefined && selectInput(settled).empty) {
        return { restored: true, ctrlU: attempt }
      }
    }
    throw new TmuxPaneNotQuiescentError('before_paste')
  }

  /** Send a key by its tmux name. `C-c` is hrc-pty's own `interrupt`. */
  async sendNamedKey(key: string): Promise<void> {
    if (this.allowedOps.sendInterrupt !== true) {
      throw new BrokerError(
        BrokerErrorCode.CapabilityDenied,
        'sendNamedKey requires allowedOps.sendInterrupt'
      )
    }
    if (key === 'C-c') {
      await this.call('interrupt')
      return
    }
    const bytes = NAMED_KEYS[key]
    if (bytes === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, `unsupported key ${key}`)
    }
    await this.write(bytes)
  }

  async interrupt(): Promise<void> {
    await this.sendNamedKey('C-c')
  }

  /** Plain text of the viewport, as tmux's `capture-pane -p` returns it. */
  async capture(): Promise<string> {
    this.requireCapture()
    return (await this.captureRaw()).text
  }

  async captureRaw(styled = false): Promise<HrcptyCapture> {
    this.requireCapture()
    return (await this.call('capture', styled ? { styled: true } : {})) as HrcptyCapture
  }

  /**
   * The cursor row in the shape the tmux input selectors read. The plain
   * capture supplies the text and the cursor; the styled capture supplies the
   * same row with its SGR so a dim placeholder can be told from typed text.
   * Undefined when capture is denied or fails.
   */
  async captureInputSnapshot(): Promise<TmuxPaneInputSnapshot | undefined> {
    if (this.allowedOps.capture !== true) return undefined
    try {
      const plain = await this.captureRaw()
      const styled = await this.captureRaw(true)
      const { x: cursorX, y: cursorY } = plain.cursor
      return {
        line: plain.text.split('\n')[cursorY] ?? '',
        styledLine: styledRows(styled.text)[cursorY] ?? '',
        cursorX,
        cursorY,
        paneWidth: plain.cols,
        paneHeight: plain.rows,
      }
    } catch {
      return undefined
    }
  }

  async resize(size: { columns?: number | undefined; rows?: number | undefined }): Promise<void> {
    if (this.allowedOps.resize !== true) {
      throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'resize requires allowedOps.resize')
    }
    if (size.columns === undefined || size.rows === undefined) return
    await this.call('resize', { cols: size.columns, rows: size.rows })
  }

  /** Drop the control connection. The supervisor, pty and child are unaffected. */
  close(): void {
    this.closed = true
    const connection = this.connection
    this.connection = undefined
    void connection?.then(({ connection: open }) => open.close()).catch(() => undefined)
  }

  private async write(text: string, ifIdleMs?: number): Promise<{ written: number }> {
    if (this.allowedOps.sendInput !== true) {
      throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'input requires allowedOps.sendInput')
    }
    return (await this.call('input', {
      bytes: Buffer.from(text, 'utf8').toString('base64'),
      ...(ifIdleMs !== undefined ? { ifIdleMs } : {}),
    })) as { written: number }
  }

  private requireCapture(): void {
    if (this.allowedOps.capture !== true) {
      throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'capture requires allowedOps.capture')
    }
  }

  private async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const { connection } = await this.openConnection()
    try {
      return await connection.call(method, params)
    } catch (error) {
      // A dropped socket is redialled on the next call; an error frame is not.
      if (!(error instanceof HrcptyRpcError)) this.connection = undefined
      throw error
    }
  }

  private openConnection(): Promise<{ connection: HrcptyOpsConnection; hello: HrcptyHello }> {
    if (this.closed) {
      return Promise.reject(
        new BrokerError(BrokerErrorCode.InvalidInvocationState, 'hrc-pty controller is closed')
      )
    }
    if (this.connection === undefined) {
      const opening = this.dial()
      this.connection = opening
      // A failed dial or hello is retried by the next call.
      opening.catch(() => {
        if (this.connection === opening) this.connection = undefined
      })
    }
    return this.connection
  }

  private async dial(): Promise<{ connection: HrcptyOpsConnection; hello: HrcptyHello }> {
    const connection = await this.connectImpl(this.socketPath)
    try {
      const hello = (await connection.call('hello', { token: await this.token() })) as HrcptyHello
      if (hello.protocol !== HRCPTY_PROTOCOL) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `hrc-pty speaks ${String(hello.protocol)}, expected ${HRCPTY_PROTOCOL}`
        )
      }
      return { connection, hello }
    } catch (error) {
      connection.close()
      throw error
    }
  }

  private async waitForInput(
    predicate: (input: ReturnType<TmuxPaneInputSelector>) => boolean,
    selectInput: TmuxPaneInputSelector,
    timeoutMs: number,
    intervalMs: number
  ): Promise<{ matched: boolean; last: ReturnType<TmuxPaneInputSelector> | undefined }> {
    const deadline = Date.now() + timeoutMs
    let last: ReturnType<TmuxPaneInputSelector> | undefined
    for (;;) {
      const snapshot = await this.captureInputSnapshot()
      last = snapshot === undefined ? undefined : selectInput(snapshot)
      if (last !== undefined && predicate(last)) return { matched: true, last }
      if (Date.now() >= deadline) return { matched: false, last }
      await sleep(intervalMs)
    }
  }

  private async waitForQuiescentInput(
    selectInput: TmuxPaneInputSelector,
    timeoutMs: number,
    intervalMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let previousEmptyFingerprint: string | undefined
    for (;;) {
      const snapshot = await this.captureInputSnapshot()
      const state = snapshot === undefined ? undefined : selectInput(snapshot)
      if (state?.empty === true) {
        if (state.fingerprint === previousEmptyFingerprint) return true
        previousEmptyFingerprint = state.fingerprint
      } else {
        previousEmptyFingerprint = undefined
      }
      if (Date.now() >= deadline) return false
      // The first empty observation is confirmed at once; a busy box backs off.
      if (state?.empty !== true) await sleep(intervalMs)
    }
  }
}

/**
 * §4.5's paste framing. A body carrying its own bracket markers would end the
 * paste early and turn the rest into keystrokes, so they are removed; CR and
 * CRLF become `\n`, which inside a paste is a newline rather than a submit.
 */
export function bracketedPaste(text: string): string {
  const body = text
    .replaceAll(BRACKET_OPEN, '')
    .replaceAll(BRACKET_CLOSE, '')
    .replace(/\r\n?/g, '\n')
  return `${BRACKET_OPEN}${body}${BRACKET_CLOSE}`
}

/**
 * Split a styled `capture` into its viewport rows. The formatter writes its
 * mode and tabstop preamble, homes the cursor, then one `\r\n` per row.
 */
export function styledRows(text: string): string[] {
  const rows = text.split('\r\n')
  const first = rows[0] ?? ''
  const home = first.lastIndexOf('\x1b[H')
  rows[0] = home === -1 ? first : first.slice(home + 3)
  return rows
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10
}
