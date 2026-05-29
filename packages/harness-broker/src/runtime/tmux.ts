import { rm } from 'node:fs/promises'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

export type TmuxExecResult = {
  stdout: string
  stderr: string
}

export type TmuxExec = (
  argv: string[],
  options?: { env?: Record<string, string | undefined> | undefined }
) => Promise<TmuxExecResult>

export type TmuxManagerOptions = {
  socketPath: string
  tmuxBin?: string | undefined
  exec?: TmuxExec | undefined
}

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

export type TmuxPaneState = {
  socketPath: string
  sessionName: string
  windowName: string
  sessionId: string
  windowId: string
  paneId: string
}

const MIN_SUPPORTED_TMUX_VERSION = {
  major: 3,
  minor: 2,
}

const WINDOW_NAME = 'main'

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
const PANE_METADATA_PATTERN = /^(\$\d+)[\t_](@\d+)[\t_](%\d+)[\t_](.+)$/
const PANE_IDENTITY_PATTERN = /^(\$\d+)[\t_](@\d+)[\t_](%\d+)$/
const PANE_IDENTITY_FORMAT = '#{session_id}\t#{window_id}\t#{pane_id}'
const SCRUB_EXACT_KEYS = new Set([
  'BUILD_NUMBER',
  'CI',
  'CLICOLOR_FORCE',
  'CONTINUOUS_INTEGRATION',
  'FORCE_COLOR',
  'GITHUB_ACTIONS',
  'NO_COLOR',
  'RUN_ID',
])
const SCRUB_PREFIXES = ['AGENTCHAT_', 'AGENT_', 'CODEX_', 'HRC_']

function sessionNameFor(hostSessionId: string): string {
  return `hrc-${hostSessionId.slice(0, 12)}`
}

function isMissingTargetError(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('no server running on') ||
    normalized.includes("can't find session") ||
    normalized.includes("can't find pane") ||
    normalized.includes("can't find window")
  )
}

function parseVersion(stdout: string, stderr: string): { major: number; minor: number } {
  const source = `${stdout}\n${stderr}`.trim()
  const match = source.match(/tmux\s+(\d+)\.(\d+)/i)
  if (!match) {
    throw new Error(`unable to parse tmux version from output: ${source || '<empty>'}`)
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
  }
}

function shouldScrubInheritedEnvKey(key: string): boolean {
  return SCRUB_EXACT_KEYS.has(key) || SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))
}

function scrubInheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !shouldScrubInheritedEnvKey(key)) {
      scrubbed[key] = value
    }
  }
  return scrubbed
}

function listInheritedEnvKeysToScrub(env: NodeJS.ProcessEnv): string[] {
  const keys = new Set<string>(SCRUB_EXACT_KEYS)
  for (const key of Object.keys(env)) {
    if (shouldScrubInheritedEnvKey(key)) {
      keys.add(key)
    }
  }
  return [...keys].sort()
}

function sanitizeTmuxClientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized = scrubInheritedEnv(env)
  const sanitizedPath = sanitizeTmuxServerPath(sanitized['PATH'])
  if (!sanitizedPath) {
    const { PATH: _discardedPath, ...withoutPath } = sanitized
    return withoutPath
  }
  sanitized['PATH'] = sanitizedPath
  return sanitized
}

function isCodexEphemeralPathEntry(entry: string): boolean {
  return (
    entry.includes('/tmp/arg0/codex-arg0') ||
    entry.includes('/node_modules/@openai/codex/') ||
    entry.includes('/node_modules/@openai/codex-darwin-arm64/vendor/')
  )
}

function sanitizeTmuxServerPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  const seen = new Set<string>()
  const entries = path
    .split(':')
    .filter((entry) => entry.length > 0)
    .filter((entry) => !isCodexEphemeralPathEntry(entry))
    .filter((entry) => {
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
  return entries.length > 0 ? entries.join(':') : undefined
}

export function parsePaneState(stdout: string, socketPath: string): TmuxPaneState {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    throw new Error('tmux command did not return pane metadata')
  }

  const match = PANE_METADATA_PATTERN.exec(line)
  if (!match) {
    throw new Error(`unexpected tmux metadata line: ${line}`)
  }

  const [, sessionId, windowId, paneId, sessionName] = match
  if (!sessionName || !sessionId || !windowId || !paneId) {
    throw new Error(`tmux metadata regex captured empty groups in line: ${line}`)
  }

  return {
    socketPath,
    sessionName,
    windowName: WINDOW_NAME,
    sessionId,
    windowId,
    paneId,
  }
}

function parsePaneIdentity(stdout: string): {
  sessionId: string
  windowId: string
  paneId: string
} {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    throw new Error('tmux command did not return pane identity')
  }

  const match = PANE_IDENTITY_PATTERN.exec(line)
  if (!match) {
    throw new Error(`unexpected tmux pane identity line: ${line}`)
  }

  const [, sessionId, windowId, paneId] = match
  if (!sessionId || !windowId || !paneId) {
    throw new Error(`tmux pane identity regex captured empty groups in line: ${line}`)
  }

  return { sessionId, windowId, paneId }
}

export class TmuxManager {
  private readonly tmuxBinary: string
  private readonly execImpl: TmuxExec

  constructor(
    private readonly socketPath: string,
    tmuxBinary = 'tmux',
    execImpl?: TmuxExec | undefined
  ) {
    this.tmuxBinary = tmuxBinary
    this.execImpl = execImpl ?? createDefaultTmuxExec()
  }

  async initialize(): Promise<void> {
    await this.checkVersion()
    await this.startServer()
    await this.scrubServerEnvironment()
  }

  async ensurePane(hostSessionId: string, restartStyle: RestartStyle): Promise<TmuxPaneState> {
    const sessionName = sessionNameFor(hostSessionId)

    if (restartStyle === 'fresh_pty') {
      const existing = await this.inspectSession(sessionName)
      if (existing) {
        const retiredSessionName = `${sessionName}-retired-${Date.now()}`
        await this.exec(['rename-session', '-t', `=${sessionName}`, retiredSessionName])
        try {
          const created = await this.createNamedSession(sessionName)
          await this.killSession(retiredSessionName)
          return created
        } catch (error) {
          await this.killSession(retiredSessionName)
          throw error
        }
      }

      return this.createNamedSession(sessionName)
    }

    const existing = await this.inspectSession(sessionName)
    if (existing) {
      return existing
    }

    return this.createNamedSession(sessionName)
  }

  async checkVersion(): Promise<void> {
    let result: TmuxExecResult
    try {
      result = await this.execRaw(['-V'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`tmux not found or unavailable: ${message}`)
    }

    const version = parseVersion(result.stdout, result.stderr)
    const supported =
      version.major > MIN_SUPPORTED_TMUX_VERSION.major ||
      (version.major === MIN_SUPPORTED_TMUX_VERSION.major &&
        version.minor >= MIN_SUPPORTED_TMUX_VERSION.minor)

    if (!supported) {
      throw new Error(`unsupported tmux version ${version.major}.${version.minor}; need 3.2+`)
    }
  }

  async createSession(hostSessionId: string): Promise<TmuxPaneState> {
    await this.startServer()
    return this.createNamedSession(sessionNameFor(hostSessionId))
  }

  async capture(paneId: string): Promise<string> {
    const result = await this.exec(['capture-pane', '-t', paneId, '-p'])
    return result.stdout
  }

  getAttachDescriptor(sessionName: string): { argv: string[] } {
    return {
      argv: [this.tmuxBinary, '-S', this.socketPath, 'attach-session', '-t', sessionName],
    }
  }

  async interrupt(paneId: string): Promise<void> {
    await this.exec(['send-keys', '-t', paneId, 'C-c'])
  }

  async terminate(sessionName: string): Promise<void> {
    await this.killSession(sessionName)
  }

  async sendLiteral(paneId: string, text: string): Promise<void> {
    if (text.length === 0) {
      return
    }

    await this.exec(['send-keys', '-l', '-t', paneId, text])
  }

  async sendEnter(paneId: string): Promise<void> {
    await this.exec(['send-keys', '-t', paneId, 'Enter'])
  }

  async sendKeys(paneId: string, keys: string): Promise<void> {
    await this.sendLiteral(paneId, keys)
    await sleep(1_000)
    await this.sendEnter(paneId)
  }

  async sendPastedLine(paneId: string, text: string): Promise<void> {
    const bufferName = `harness-broker-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await this.exec(['set-buffer', '-b', bufferName, text])
    await this.exec(['paste-buffer', '-d', '-b', bufferName, '-t', paneId])
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await this.sendEnter(paneId)
  }

  async inspectSession(sessionName: string): Promise<TmuxPaneState | null> {
    try {
      const result = await this.exec([
        'list-panes',
        '-t',
        `=${sessionName}:${WINDOW_NAME}`,
        '-F',
        '#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}',
      ])
      return parsePaneState(result.stdout, this.socketPath)
    } catch (error) {
      if (error instanceof Error && isMissingTargetError(error.message)) {
        return null
      }
      throw error
    }
  }

  private async createNamedSession(sessionName: string): Promise<TmuxPaneState> {
    const args = ['new-session', '-d']
    const sanitizedPath = sanitizeTmuxServerPath(process.env['PATH'])
    if (sanitizedPath) {
      args.push('-e', `PATH=${sanitizedPath}`)
    }
    args.push(
      '-P',
      '-s',
      sessionName,
      '-n',
      WINDOW_NAME,
      '-F',
      '#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}'
    )

    const result = await this.exec(args)
    return parsePaneState(result.stdout, this.socketPath)
  }

  private async scrubServerEnvironment(): Promise<void> {
    for (const key of listInheritedEnvKeysToScrub(process.env)) {
      try {
        await this.exec(['set-environment', '-gu', key])
      } catch {
        // Best effort: keep startup resilient if a key is already absent.
      }
    }
  }

  private async killSession(sessionName: string): Promise<void> {
    try {
      await this.exec(['kill-session', '-t', `=${sessionName}`])
    } catch (error) {
      if (error instanceof Error && isMissingTargetError(error.message)) {
        return
      }
      throw error
    }
  }

  private async startServer(): Promise<void> {
    try {
      await this.exec(['start-server'])
    } catch {
      await rm(this.socketPath, { force: true }).catch(() => undefined)
      await this.exec(['start-server'])
    }
  }

  private async exec(args: string[]): Promise<TmuxExecResult> {
    return this.execRaw(['-S', this.socketPath, ...args])
  }

  private async execRaw(args: string[]): Promise<TmuxExecResult> {
    return this.execImpl([this.tmuxBinary, ...args], {
      env: sanitizeTmuxClientEnv(process.env),
    })
  }
}

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
    await this.sendLiteral(keys)
    await sleep(1_000)
    await this.sendEnter()
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

  /** set-buffer + paste-buffer the text into the leased pane (not yet submitted). */
  private async pasteBuffer(text: string): Promise<void> {
    const bufferName = `harness-broker-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await this.exec(['set-buffer', '-b', bufferName, '-t', this.lease.paneId, text])
    await this.exec(['paste-buffer', '-d', '-b', bufferName, '-t', this.lease.paneId])
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

  async interrupt(): Promise<void> {
    await this.exec(['send-keys', '-t', this.lease.paneId, 'C-c'])
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

export function createTmuxManager(options: TmuxManagerOptions): TmuxManager {
  return new TmuxManager(options.socketPath, options.tmuxBin, options.exec)
}

export function createTmuxPaneController(options: TmuxPaneControllerOptions): TmuxPaneController {
  return new TmuxPaneController(options)
}
