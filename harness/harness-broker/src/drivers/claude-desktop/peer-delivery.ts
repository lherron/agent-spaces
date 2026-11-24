import { readFileSync, readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import {
  BrokerErrorCode,
  type InputId,
  type InvocationInput,
  type TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerError, errorMessage } from '../../errors'
import { type DeliveryEvidence, type DriverContext, withDeliveryEvidence } from '../driver'
import { CLAUDE_DESKTOP_DRIVER_KIND } from './transcript-plan'

/** The `submission.rejected` reason for a receiver in bypassPermissions mode (T-14466 r3). */
export const RECEIVER_BYPASS_PERMISSIONS = 'receiver_bypass_permissions'

/** How long a written attempt waits for its marker before it is settled `submission.lost`. */
export const DEFAULT_CONFIRM_WINDOW_MS = 30_000

/**
 * Once the session's transcript shows the body queued, Claude holds it until
 * the next tool boundary or the turn's end, which can be minutes away (a
 * 45 s tool call held one past the 30 s window live, 2026-11-24). This
 * backstop still settles a queued body that never surfaces, so a lost row
 * cannot hold the session's fence for the rest of the broker's life.
 */
export const DEFAULT_QUEUED_WINDOW_MS = 15 * 60_000

/** How long the UserPromptSubmit witness waits for the transcript to settle first. */
const HOOK_WITNESS_GRACE_MS = 1_000

const WRITE_TIMEOUT_MS = 5_000
/** The peer protocol and Claude Code versions the socket framing was probed on (2026-11-23). */
const PROBED_PEER_PROTOCOL = 1
const PROBED_VERSIONS = new Set(['2.1.330', '2.1.331'])

const MARKER = /\[hrc:input ([^\]\s]+)\]/g

/** Every input id named by an `[hrc:input <id>]` marker in `text`. */
export function inputMarkersIn(text: string): string[] {
  return [...text.matchAll(MARKER)].map((match) => match[1] as string)
}

/**
 * The content written to the session: an HRC sender line, the body, then the
 * input marker. The session records the broker's pid as the sender, never the
 * author, so the sender line names who sent it.
 */
export function peerMessageBody(input: InvocationInput & { inputId: InputId }): string {
  const text = input.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((part) => part.length > 0)
    .join('\n\n')
  const metadata = input.metadata ?? {}
  const sender = metadata['scopeRef'] ?? metadata['principalRef'] ?? 'unknown'
  const envelope = metadata['envelopeId']
  const senderLine = `[HRC delivery from ${sender}${envelope !== undefined ? `, envelope ${envelope}` : ''}]`
  return `${senderLine}\n${text}\n\n[hrc:input ${input.inputId}]`
}

/** The session's registry row, `~/.claude/sessions/<pid>.json`: undocumented, read defensively. */
interface RegistryRow {
  sessionId?: string
  messagingSocketPath?: string
  version?: string
  peerProtocol?: number
  status?: string
  waitingFor?: string
}

export interface ClaudeDesktopPeerDeliveryOptions {
  sessionId: string
  claudeHome: string
  /** The session's claude pid; defaults to `CLAUDE_PID` in `env`. */
  pid?: number | undefined
  /** The joiner inherits the hook env: `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_SOCKET/_TOKEN`. */
  env?: Record<string, string | undefined> | undefined
  confirmWindowMs?: number | undefined
  /** After the transcript shows the body queued. */
  queuedWindowMs?: number | undefined
}

export interface ClaudeDesktopPeerDelivery {
  /** Bind to a started invocation. */
  open(ctx: DriverContext, attribution: DeliveryAttribution): void
  /** The broker's steer door: write one message, idle or busy. */
  steer(input: InvocationInput): Promise<void>
  /** Latest receiver permission mode, from a hook payload or a transcript prompt row. */
  notePermissionMode(mode: string | undefined): void
  /** A submission terminal went out for `submissionId`; release its attempt fence. */
  noteSubmissionTerminal(submissionId: string): void
  /** The transcript shows the session queued `inputId`: received, not yet executed. */
  noteQueued(inputId: string): void
  /** A UserPromptSubmit `prompt` named markers: executed, credited to `turnId`. */
  notePromptMarkers(prompt: string, turnId: TurnId | undefined): void
  /** Whether this broker life wrote (or tried to write) `inputId` to the session. */
  wrote(inputId: string): boolean
  close(): void
}

/** What the delivery asks of the transcript observer's attribution. */
export interface DeliveryAttribution {
  track(inputId: InputId, body: string): void
  forget(inputId: InputId): void
}

interface Attempt {
  inputId: InputId
  timer?: ReturnType<typeof setTimeout> | undefined
  /** Set once the transcript shows the body queued. */
  queued?: boolean | undefined
  settled: Promise<void>
  resolve: () => void
}

/**
 * Delivery into a desktop session through its cross-session messaging socket
 * (T-14466). One unresolved attempt per session: a later steer waits until
 * the earlier one is executed or settled lost. Once bytes are written the
 * attempt is possibly written and is never resent. The marker in a peer
 * transcript record or a UserPromptSubmit prompt proves it executed; no
 * marker within the window settles it `submission.lost` and delivery
 * continues. A bypassPermissions receiver gets no write at all.
 */
export function createClaudeDesktopPeerDelivery(
  options: ClaudeDesktopPeerDeliveryOptions
): ClaudeDesktopPeerDelivery {
  const env = options.env ?? process.env
  const windowMs = options.confirmWindowMs ?? DEFAULT_CONFIRM_WINDOW_MS
  const queuedWindowMs = options.queuedWindowMs ?? DEFAULT_QUEUED_WINDOW_MS
  let ctx: DriverContext | undefined
  let attribution: DeliveryAttribution | undefined
  let permissionMode: string | undefined
  let current: Attempt | undefined
  let closed = true
  const warned = new Set<string>()
  /** Bounded: only recent attempts can still show up in the transcript. */
  const written: string[] = []

  function pid(): number | undefined {
    const value = options.pid ?? Number(env['CLAUDE_PID'])
    return Number.isSafeInteger(value) && value > 1 ? value : undefined
  }

  function readRegistry(sessionPid: number | undefined): RegistryRow | undefined {
    if (sessionPid === undefined) return undefined
    try {
      const row = JSON.parse(
        readFileSync(join(options.claudeHome, 'sessions', `${sessionPid}.json`), 'utf8')
      ) as RegistryRow
      return typeof row === 'object' && row !== null ? row : undefined
    } catch {
      return undefined
    }
  }

  /** The session's own token: the inherited env when it is this pid's, else its key file. */
  function token(sessionPid: number | undefined): string | undefined {
    if (sessionPid === undefined) return undefined
    const fromEnv = env['CLAUDE_CODE_MESSAGING_TOKEN']
    if (fromEnv !== undefined && fromEnv.length > 0 && Number(env['CLAUDE_PID']) === sessionPid) {
      return fromEnv
    }
    try {
      const dir = join(options.claudeHome, 'sessions')
      const key = readdirSync(dir).find(
        (name) => name.startsWith(`${sessionPid}.`) && name.endsWith('.key')
      )
      if (key === undefined) return undefined
      const parsed = JSON.parse(readFileSync(join(dir, key), 'utf8')) as { peerToken?: unknown }
      return typeof parsed.peerToken === 'string' ? parsed.peerToken : undefined
    } catch {
      return undefined
    }
  }

  function notice(code: string, message: string, data: Record<string, unknown>): void {
    ctx?.emit(
      'driver.notice',
      { message, code, data },
      { driver: { kind: CLAUDE_DESKTOP_DRIVER_KIND, rawType: 'peer.delivery' } }
    )
  }

  /** Fail open on an unprobed version: warn once, deliver anyway. */
  function warnOnDrift(row: RegistryRow | undefined): void {
    const drift: Record<string, unknown> = {}
    if (row?.peerProtocol !== PROBED_PEER_PROTOCOL)
      drift['peerProtocol'] = row?.peerProtocol ?? null
    if (row?.version === undefined || !PROBED_VERSIONS.has(row.version)) {
      drift['version'] = row?.version ?? null
    }
    if (Object.keys(drift).length === 0) return
    const key = JSON.stringify(drift)
    if (warned.has(key)) return
    warned.add(key)
    notice(
      'CLAUDE_DESKTOP_PEER_PROTOCOL_UNPROBED',
      'Claude desktop session reports an unprobed version or peer protocol; delivering anyway',
      drift
    )
  }

  function refuse(reason: string, evidence: DeliveryEvidence, data?: unknown): never {
    throw withDeliveryEvidence(
      new BrokerError(BrokerErrorCode.DriverUnavailable, reason, data),
      evidence
    )
  }

  /** Write the auth line and the message, then close. The socket replies nothing. */
  function write(socketPath: string, authToken: string | undefined, body: string): Promise<void> {
    const frames: unknown[] = [{ type: 'user', message: { role: 'user', content: body } }]
    if (authToken !== undefined) frames.unshift({ type: 'auth', token: authToken })
    const lines = frames.map((frame) => `${JSON.stringify(frame)}\n`).join('')
    return new Promise<void>((resolve, reject) => {
      let connected = false
      let failure: unknown
      const socket = connect(socketPath)
      const timer = setTimeout(() => {
        failure ??= new Error('Claude desktop messaging socket write timed out')
        socket.destroy()
      }, WRITE_TIMEOUT_MS)
      socket.once('connect', () => {
        connected = true
        socket.end(lines)
      })
      socket.on('data', () => undefined)
      socket.once('error', (error) => {
        failure ??= error
      })
      socket.once('close', () => {
        clearTimeout(timer)
        if (failure === undefined) {
          resolve()
          return
        }
        // Nothing crossed before connect; from connect on the body may have.
        reject(
          withDeliveryEvidence(
            new BrokerError(
              BrokerErrorCode.DriverUnavailable,
              `Claude desktop messaging socket write failed: ${errorMessage(failure)}`
            ),
            connected ? 'possibly_written' : 'not_written'
          )
        )
      })
    })
  }

  function arm(attempt: Attempt, ms: number): void {
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
    attempt.timer = setTimeout(() => settleLost(attempt, ms), ms)
    attempt.timer.unref?.()
  }

  function settleLost(attempt: Attempt, elapsedWindowMs: number): void {
    if (current !== attempt) return
    const active = ctx
    const row = readRegistry(pid())
    attribution?.forget(attempt.inputId)
    notice(
      'CLAUDE_DESKTOP_DELIVERY_UNCONFIRMED',
      `No delivery marker for ${attempt.inputId} within ${elapsedWindowMs} ms; settled lost, delivery continues`,
      {
        inputId: attempt.inputId,
        windowMs: elapsedWindowMs,
        queued: attempt.queued === true,
        ...(row?.status !== undefined ? { receiverStatus: row.status } : {}),
        ...(row?.waitingFor !== undefined ? { receiverWaitingFor: row.waitingFor } : {}),
      }
    )
    active?.emit(
      'submission.lost',
      { submissionId: attempt.inputId, reason: 'turn-correlation-lost' },
      { inputId: attempt.inputId, driver: { kind: CLAUDE_DESKTOP_DRIVER_KIND } }
    )
    // The emit above releases the fence; this covers a context with no emit seam.
    release(attempt)
  }

  function release(attempt: Attempt): void {
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
    attempt.timer = undefined
    if (current === attempt) current = undefined
    attempt.resolve()
  }

  return {
    open(nextCtx, nextAttribution) {
      ctx = nextCtx
      attribution = nextAttribution
      closed = false
    },

    async steer(input) {
      const inputId = input.inputId
      if (inputId === undefined) refuse('Claude desktop delivery needs an input id', 'not_written')
      // One unresolved attempt per session: wait for the earlier one to settle.
      while (current !== undefined && !closed) await current.settled
      if (closed || ctx === undefined) {
        refuse('Claude desktop delivery closed before writing', 'not_written')
      }
      if (permissionMode === 'bypassPermissions') {
        refuse(RECEIVER_BYPASS_PERMISSIONS, 'not_written', { permissionMode })
      }
      const sessionPid = pid()
      const row = readRegistry(sessionPid)
      if (row?.sessionId !== undefined && row.sessionId !== options.sessionId) {
        refuse('Claude desktop registry row names another session', 'not_written', {
          pid: sessionPid ?? null,
        })
      }
      const socketPath =
        row?.messagingSocketPath ??
        (Number(env['CLAUDE_PID']) === sessionPid ? env['CLAUDE_CODE_MESSAGING_SOCKET'] : undefined)
      if (socketPath === undefined || socketPath.length === 0) {
        refuse('Claude desktop messaging socket is unknown', 'not_written', {
          pid: sessionPid ?? null,
        })
      }
      warnOnDrift(row)
      const body = peerMessageBody({ ...input, inputId })
      let resolveSettled: () => void = () => undefined
      const attempt: Attempt = {
        inputId,
        settled: new Promise<void>((resolve) => {
          resolveSettled = resolve
        }),
        resolve: () => resolveSettled(),
      }
      // Tracked before the write so a fast transcript row cannot beat it.
      current = attempt
      written.push(inputId)
      if (written.length > 64) written.shift()
      attribution?.track(inputId, body)
      try {
        await write(socketPath, token(sessionPid), body)
      } catch (error) {
        if ((error as { deliveryEvidence?: string }).deliveryEvidence === 'not_written') {
          attribution?.forget(inputId)
          release(attempt)
          throw error
        }
        // Possibly written: keep the fence and the window; never resend.
        if (current === attempt && attempt.queued !== true) arm(attempt, windowMs)
        throw error
      }
      // A fast transcript row may already have queued or settled it.
      if (current === attempt && attempt.queued !== true) arm(attempt, windowMs)
    },

    notePermissionMode(mode) {
      if (mode !== undefined) permissionMode = mode
    },

    noteSubmissionTerminal(submissionId) {
      if (current?.inputId === submissionId) release(current)
    },

    noteQueued(inputId) {
      const attempt = current
      if (attempt?.inputId !== inputId || attempt.queued === true) return
      attempt.queued = true
      arm(attempt, queuedWindowMs)
      notice(
        'CLAUDE_DESKTOP_DELIVERY_QUEUED',
        `Claude desktop session queued ${inputId}; it runs at the next tool boundary or turn end`,
        { inputId, queuedWindowMs }
      )
    },

    notePromptMarkers(prompt, turnId) {
      const attempt = current
      if (attempt === undefined || turnId === undefined) return
      if (!inputMarkersIn(prompt).includes(attempt.inputId)) return
      // The transcript is the first witness; the hook settles only what it has not.
      const witness = setTimeout(() => {
        if (current !== attempt || ctx === undefined) return
        ctx.emit(
          'submission.executed',
          { submissionId: attempt.inputId, turnId },
          {
            turnId,
            inputId: attempt.inputId,
            driver: { kind: CLAUDE_DESKTOP_DRIVER_KIND, rawType: 'hook.UserPromptSubmit' },
          }
        )
        release(attempt)
      }, HOOK_WITNESS_GRACE_MS)
      witness.unref?.()
    },

    wrote(inputId) {
      return written.includes(inputId)
    },

    close() {
      closed = true
      const attempt = current
      if (attempt !== undefined) release(attempt)
      ctx = undefined
      attribution = undefined
    },
  }
}
