import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'
import { sanitizeTmuxClientEnv } from './tmux-env'
import { PANE_IDENTITY_FORMAT, parsePaneIdentity } from './tmux-parse'

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

export type TmuxExecResult = {
  stdout: string
  stderr: string
}

export type TmuxExec = (
  argv: string[],
  options?: { env?: Record<string, string | undefined> | undefined }
) => Promise<TmuxExecResult>

export type TmuxPaneAllowedOps = {
  inspect?: boolean | undefined
  sendInput?: boolean | undefined
  sendInterrupt?: boolean | undefined
  capture?: boolean | undefined
  resize?: boolean | undefined
}

export type TmuxPaneControllerLease = {
  paneId: string
  sessionId: string
  windowId: string
  sessionName?: string | undefined
  windowName?: string | undefined
  allowedOps: TmuxPaneAllowedOps
}

export type TmuxPaneControllerOptions = {
  socketPath: string
  tmuxBin?: string | undefined
  exec?: TmuxExec | undefined
  lease: TmuxPaneControllerLease
}

export const PANE_NOT_QUIESCENT_REASON = 'pane_not_quiescent' as const

export type TmuxPaneInputSnapshot = {
  /** Plain text rendered on the row containing the pane cursor. */
  line: string
  /** The same row with tmux's SGR escape sequences retained. */
  styledLine: string
  cursorX: number
  cursorY: number
  paneWidth: number
  paneHeight: number
}

export type TmuxPaneInputState = {
  empty: boolean
  /** Stable identity for the input state; equal empty states may land a steer. */
  fingerprint: string
}

export type TmuxPaneInputSelector = (snapshot: TmuxPaneInputSnapshot) => TmuxPaneInputState

export type TmuxSteerOptions = {
  selectInput: TmuxPaneInputSelector
  quiescenceTimeoutMs?: number | undefined
  quiescencePollIntervalMs?: number | undefined
  landingTimeoutMs?: number | undefined
  landingPollIntervalMs?: number | undefined
}

/**
 * Typed, fail-closed steer rejection. The broker publishes {@link reason} as
 * the submission rejection reason so HRC can redeliver by policy.
 */
export class TmuxPaneNotQuiescentError extends Error {
  readonly reason = PANE_NOT_QUIESCENT_REASON
  readonly phase: 'before_paste' | 'after_submit'

  constructor(phase: 'before_paste' | 'after_submit') {
    super(PANE_NOT_QUIESCENT_REASON)
    this.name = 'TmuxPaneNotQuiescentError'
    this.phase = phase
  }
}

export type TmuxPaneInspection = {
  paneId: string
  sessionId: string
  windowId: string
  alive: boolean
}

export type TmuxPaneResize = {
  columns?: number | undefined
  rows?: number | undefined
}

// sendPastedLine submit tuning (T-01734, hardened T-01747). The launch command is
// pasted into the leased pane, then Enter is pressed to submit it. Two failure
// modes are handled deterministically via capture-pane signals instead of blind
// timers:
//   1. paste-buffer is DROPPED entirely if the leased pane's shell PTY is not yet
//      reading on a cold launch — so we (re)paste, discarding any partial with
//      C-c first, until the command actually renders at the prompt. This replaces
//      the codex driver's blind pre-paste sleep AND the bare-shell fallout that
//      a dropped paste left behind.
//   2. once present, Enter is pressed and we confirm the command line left the
//      prompt, re-pressing Enter (bounded) while it is still sitting there.
// PASTE_RENDER_TIMEOUT_MS is the per-attempt budget for a paste to render: a paste
// that lands matches within a poll or two; a dropped paste burns this budget then
// triggers a re-paste. MAX_PASTE_ATTEMPTS bounds the cold-start wait.
const PASTE_RENDER_TIMEOUT_MS = 1_500
const MAX_PASTE_ATTEMPTS = 5
const PRESENT_POLL_INTERVAL_MS = 150
const SUBMIT_CONFIRM_TIMEOUT_MS = 1_500
const SUBMIT_POLL_INTERVAL_MS = 150
const MAX_SUBMIT_ATTEMPTS = 5
// Used only when the lease does not grant capture (we cannot observe the pane).
const LEGACY_PASTE_GAP_MS = 1_000
// Trailing window of the pasted command used as the present / still-unexecuted
// needle (whitespace-stripped so terminal line-wrap inside the window never breaks
// the match — capture-pane hard-wraps long commands at pane width).
const COMMAND_TAIL_LEN = 60
const STEER_QUIESCENCE_TIMEOUT_MS = 5_000
const STEER_QUIESCENCE_POLL_INTERVAL_MS = 250
const STEER_LANDING_TIMEOUT_MS = 1_500
const STEER_LANDING_POLL_INTERVAL_MS = 150

export class TmuxPaneController {
  private readonly socketPath: string
  private readonly tmuxBinary: string
  private readonly execImpl: TmuxExec
  private readonly lease: TmuxPaneControllerLease

  constructor(options: TmuxPaneControllerOptions) {
    this.socketPath = options.socketPath
    this.tmuxBinary = options.tmuxBin ?? 'tmux'
    this.execImpl = options.exec ?? createDefaultTmuxExec()
    this.lease = options.lease

    const { allowedOps } = this.lease
    if (allowedOps.inspect !== true) {
      throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'inspect requires allowedOps.inspect')
    }
    if (allowedOps.sendInput !== true) {
      throw new BrokerError(
        BrokerErrorCode.CapabilityDenied,
        'sendInput requires allowedOps.sendInput'
      )
    }
    if (allowedOps.sendInterrupt !== true) {
      throw new BrokerError(
        BrokerErrorCode.CapabilityDenied,
        'sendInterrupt requires allowedOps.sendInterrupt'
      )
    }
  }

  async inspect(): Promise<TmuxPaneInspection> {
    const result = await this.exec([
      'display-message',
      '-p',
      '-t',
      this.lease.paneId,
      '-F',
      PANE_IDENTITY_FORMAT,
    ])
    const { sessionId, windowId, paneId } = parsePaneIdentity(result.stdout)
    return { paneId, sessionId, windowId, alive: true }
  }

  async sendLiteral(text: string): Promise<void> {
    if (text.length === 0) {
      return
    }

    await this.exec(['send-keys', '-l', '-t', this.lease.paneId, text])
  }

  async sendEnter(): Promise<void> {
    await this.exec(['send-keys', '-t', this.lease.paneId, 'Enter'])
  }

  async sendKeys(keys: string): Promise<void> {
    await this.pasteBuffer(keys)
    await sleep(1_000)
    await this.sendEnter()
  }

  /**
   * Guard and atomically submit a live-turn steer.
   *
   * A human and the broker share this pane. Before writing, require two
   * consecutive, identical observations of an empty driver-selected input
   * region. The body then crosses the PTY as one bracketed tmux paste followed
   * by exactly one Enter, so operator keystrokes cannot split the body. Finally,
   * require the input region to clear; residual text means the submission did
   * not land safely and is rejected for policy-driven redelivery.
   */
  async sendSteer(text: string, options: TmuxSteerOptions): Promise<void> {
    if (this.lease.allowedOps.capture !== true) {
      throw new TmuxPaneNotQuiescentError('before_paste')
    }

    const quiescent = await this.waitForQuiescentInput(
      options.selectInput,
      options.quiescenceTimeoutMs ?? STEER_QUIESCENCE_TIMEOUT_MS,
      options.quiescencePollIntervalMs ?? STEER_QUIESCENCE_POLL_INTERVAL_MS
    )
    if (!quiescent) {
      throw new TmuxPaneNotQuiescentError('before_paste')
    }

    await this.pasteBuffer(text)
    await this.sendEnter()

    const landed = await this.waitForInputEmpty(
      options.selectInput,
      options.landingTimeoutMs ?? STEER_LANDING_TIMEOUT_MS,
      options.landingPollIntervalMs ?? STEER_LANDING_POLL_INTERVAL_MS
    )
    if (!landed) {
      throw new TmuxPaneNotQuiescentError('after_submit')
    }
  }

  /**
   * Paste-confirm-submit (T-01734, hardened T-01747): land the launch command at
   * the leased pane's prompt and submit it using deterministic capture-pane
   * signals — no blind timers.
   *
   * 1. (Re)paste until the command renders at the prompt. paste-buffer is dropped
   *    if the pane's shell PTY is not yet reading on a cold launch, so a single
   *    paste can silently vanish; we re-paste (discarding any partial fragment
   *    with C-c first, so a re-paste never concatenates onto a stale line) until
   *    the command is observed present. This replaces the codex driver's blind
   *    pre-paste sleep and removes the bare-shell fallout of a dropped paste.
   * 2. Press Enter and confirm the command left the prompt; re-press Enter
   *    (bounded) while it is still sitting there (a swallowed Enter). Once the
   *    line advances we stop, so no stray Enter is injected into the launched
   *    program.
   *
   * Degrades to a single blind paste + gap + Enter when the lease cannot observe
   * the pane (no capture).
   */
  async sendPastedLine(text: string): Promise<void> {
    const tail = commandTail(text)

    // No capture → cannot observe the pane; best-effort single blind submit.
    if (this.lease.allowedOps.capture !== true) {
      await this.pasteBuffer(text)
      await sleep(LEGACY_PASTE_GAP_MS)
      await this.sendEnter()
      return
    }

    // Step 1: (re)paste until the command is present at the prompt.
    let present = false
    for (let attempt = 0; attempt < MAX_PASTE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.discardPromptLine()
      }
      await this.pasteBuffer(text)
      const rendered = await this.waitForPane(
        (pane) => normalizePane(pane).includes(tail),
        PASTE_RENDER_TIMEOUT_MS,
        PRESENT_POLL_INTERVAL_MS
      )
      if (rendered === true) {
        present = true
        break
      }
    }
    if (!present) {
      // Never rendered within budget: best-effort single Enter, no worse than legacy.
      await this.sendEnter()
      return
    }

    // Step 2: submit and confirm the command line advanced past the prompt.
    // Because we know the command WAS present, "no longer ends with the command"
    // now reliably means it was accepted (the prompt advanced or a program took
    // over the pane), not merely that it has not been typed yet.
    for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
      await this.sendEnter()
      const advanced = await this.waitForPane(
        (pane) => !normalizePane(pane).endsWith(tail),
        SUBMIT_CONFIRM_TIMEOUT_MS,
        SUBMIT_POLL_INTERVAL_MS
      )
      if (advanced === true) {
        return
      }
    }
  }

  /**
   * Load text through a private file and paste it into the leased pane.
   *
   * Prompt-sized text must not ride in the tmux client's argv: concurrent large
   * inputs can exceed the OS command-line limit before tmux sees them. A unique
   * named buffer prevents independent broker panes from contending with tmux's
   * default buffer, while paste-buffer -d removes it after a successful paste.
   *
   * The paste is bracketed (-p). tmux hands the pane's PTY the text in
   * ~1022-byte read() chunks; without bracketed-paste framing the TUI has to
   * classify each chunk by size, and Claude Code (2.1.243/2.1.246 observed)
   * treats a large chunk as a paste and a following small chunk as typed keys,
   * discarding the buffered paste — payloads of 1023..~1822 bytes lost exactly
   * their first 1022 bytes. Framing makes the whole payload one paste regardless
   * of chunking, and stops the LF→CR translation the unframed paste applied.
   */
  private async pasteBuffer(text: string): Promise<void> {
    const bufferName = `harness-broker-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const tempDirectory = await mkdtemp(join(tmpdir(), 'harness-broker-tmux-'))
    const tempPath = join(tempDirectory, 'input')
    let bufferLoaded = false

    try {
      await chmod(tempDirectory, 0o700)
      await writeFile(tempPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await this.exec(['load-buffer', '-b', bufferName, tempPath])
      bufferLoaded = true
      await this.exec(['paste-buffer', '-d', '-p', '-b', bufferName, '-t', this.lease.paneId])
      bufferLoaded = false
    } finally {
      if (bufferLoaded) {
        try {
          await this.exec(['delete-buffer', '-b', bufferName])
        } catch {
          // Best-effort cleanup: preserve the original paste failure.
        }
      }
      try {
        await rm(tempDirectory, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup: preserve the original paste failure.
      }
    }
  }

  /**
   * Abort any partially-rendered paste with C-c so a re-paste starts from a clean
   * prompt and never concatenates onto a stale fragment (which would submit a
   * malformed command line). Safe here: only the pane's shell is at the prompt —
   * the harness has not started yet.
   */
  private async discardPromptLine(): Promise<void> {
    await this.exec(['send-keys', '-t', this.lease.paneId, 'C-c'])
  }

  /** Best-effort capture for submit confirmation; undefined if denied/failed. */
  private async captureForSubmit(): Promise<string | undefined> {
    if (this.lease.allowedOps.capture !== true) {
      return undefined
    }
    try {
      const result = await this.exec(['capture-pane', '-t', this.lease.paneId, '-p', '-S', '-200'])
      return result.stdout
    } catch {
      return undefined
    }
  }

  /** Capture the cursor row, which is the active input row in supported TUIs. */
  private async captureInputSnapshot(): Promise<TmuxPaneInputSnapshot | undefined> {
    if (this.lease.allowedOps.capture !== true) {
      return undefined
    }
    try {
      const position = await this.exec([
        'display-message',
        '-p',
        '-t',
        this.lease.paneId,
        '-F',
        '#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}',
      ])
      const fields = position.stdout.trim().split('\t').map(Number)
      const [cursorX, cursorY, paneWidth, paneHeight] = fields
      if (
        fields.length !== 4 ||
        cursorX === undefined ||
        cursorY === undefined ||
        paneWidth === undefined ||
        paneHeight === undefined ||
        fields.some((field) => !Number.isSafeInteger(field) || field < 0)
      ) {
        return undefined
      }
      const captured = await this.exec([
        'capture-pane',
        '-p',
        '-e',
        '-t',
        this.lease.paneId,
        '-S',
        String(cursorY),
        '-E',
        String(cursorY),
      ])
      const styledLine = captured.stdout.replace(/\r?\n$/, '')
      return {
        line: stripAnsi(styledLine),
        styledLine,
        cursorX,
        cursorY,
        paneWidth,
        paneHeight,
      }
    } catch {
      return undefined
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
        if (state.fingerprint === previousEmptyFingerprint) {
          return true
        }
        previousEmptyFingerprint = state.fingerprint
      } else {
        previousEmptyFingerprint = undefined
      }
      if (Date.now() >= deadline) {
        return false
      }
      // The first empty observation is immediately confirmed. Contended panes
      // back off before their next observation.
      if (state?.empty !== true) {
        await sleep(intervalMs)
      }
    }
  }

  private async waitForInputEmpty(
    selectInput: TmuxPaneInputSelector,
    timeoutMs: number,
    intervalMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const snapshot = await this.captureInputSnapshot()
      if (snapshot !== undefined && selectInput(snapshot).empty) {
        return true
      }
      if (Date.now() >= deadline) {
        return false
      }
      await sleep(intervalMs)
    }
  }

  /**
   * Poll capture-pane until `predicate` holds. Returns true on match, false on
   * timeout, or 'no-capture' when the lease cannot observe the pane.
   */
  private async waitForPane(
    predicate: (pane: string) => boolean,
    timeoutMs: number,
    intervalMs: number
  ): Promise<boolean | 'no-capture'> {
    if (this.lease.allowedOps.capture !== true) {
      return 'no-capture'
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pane = await this.captureForSubmit()
      if (pane !== undefined && predicate(pane)) {
        return true
      }
      if (Date.now() >= deadline) {
        return false
      }
      await sleep(intervalMs)
    }
  }

  /**
   * Send a single tmux key name (e.g. `C-c`, `Escape`) to the leased pane.
   * Interrupt-class, so it is gated by the same allowedOps the constructor
   * already requires. Which key actually interrupts is harness-specific: the
   * shell-hosted TUIs take `C-c`, the Pi TUI takes `Escape`.
   */
  async sendNamedKey(key: string): Promise<void> {
    if (this.lease.allowedOps.sendInterrupt !== true) {
      throw new BrokerError(
        BrokerErrorCode.CapabilityDenied,
        'sendNamedKey requires allowedOps.sendInterrupt'
      )
    }
    await this.exec(['send-keys', '-t', this.lease.paneId, key])
  }

  async interrupt(): Promise<void> {
    await this.sendNamedKey('C-c')
  }

  async capture(): Promise<string> {
    if (this.lease.allowedOps.capture !== true) {
      throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'capture requires allowedOps.capture')
    }

    const result = await this.exec(['capture-pane', '-t', this.lease.paneId, '-p'])
    return result.stdout
  }

  async resize(_size: TmuxPaneResize): Promise<void> {
    if (this.lease.allowedOps.resize !== true) {
      throw new BrokerError(BrokerErrorCode.CapabilityDenied, 'resize requires allowedOps.resize')
    }
  }

  private async exec(args: string[]): Promise<TmuxExecResult> {
    return this.execImpl([this.tmuxBinary, '-S', this.socketPath, ...args], {
      env: sanitizeTmuxClientEnv(process.env),
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Remove terminal SGR/control sequences while retaining rendered text. */
function stripAnsi(text: string): string {
  const csi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
  return text.replace(csi, '')
}

/**
 * Strip ALL whitespace (including terminal line-wrap newlines) so capture-pane
 * content can be matched regardless of pane width. capture-pane hard-wraps a long
 * pasted command at the pane width with a newline the original command never had;
 * collapsing those wraps to a SPACE would corrupt the content (e.g. ".../codex.lau\nnch.json"
 * -> ".../codex.lau nch.json"), breaking a substring/suffix match whenever a wrap
 * falls inside the needle. Removing whitespace from both haystack and needle is
 * wrap-agnostic for presence checks on space-free command tails (paths/flags).
 */
function normalizePane(text: string): string {
  return text.replace(/\s+/g, '')
}

/** Trailing window of the pasted command used as the settled/unexecuted needle. */
function commandTail(text: string): string {
  const normalized = normalizePane(text)
  return normalized.slice(-Math.min(normalized.length, COMMAND_TAIL_LEN))
}

function createDefaultTmuxExec(): TmuxExec {
  return async (argv, options) => {
    const spawnOptions: Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'> =
      options?.env === undefined
        ? { stdout: 'pipe', stderr: 'pipe' }
        : { env: options.env, stdout: 'pipe', stderr: 'pipe' }
    const proc = Bun.spawn(argv, spawnOptions)

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      const rendered = stderr.trim() || stdout.trim() || `tmux exited with status ${exitCode}`
      throw new Error(rendered)
    }

    return { stdout, stderr }
  }
}

export function createTmuxPaneController(options: TmuxPaneControllerOptions): TmuxPaneController {
  return new TmuxPaneController(options)
}
