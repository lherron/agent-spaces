/**
 * T-06365 — the live status line at the foot of the Codex app-server pane.
 *
 * The transcript is an append-only, multi-turn scrollback stream: it commits each
 * event as it finalizes and never redraws. That is the right model for history,
 * but it means a turn that is thinking — or running a long tool — prints nothing,
 * and the operator cannot tell a working session from a wedged one.
 *
 * This module adds the one thing the transcript deliberately is not: an EPHEMERAL
 * row, repainted several times a second, that exists only while the invocation is
 * mid-turn. It is not part of the transcript and never reaches scrollback. The
 * discipline that guarantees that is a single rule — the row is erased before any
 * transcript line is committed, and repainted after — so the committed stream is
 * byte-identical to what it would be with no status line at all.
 *
 * Ownership split: `transcript.ts` owns what the row LOOKS like (it is a forge
 * lane like every other band); this module owns WHEN it paints and the cursor
 * mechanics that keep it out of history. The clock is injectable, so the frame
 * sequence is testable without a TTY or a real timer.
 */

/** Return to column 0 and clear the row. The whole trick, in three bytes. */
const ERASE_ROW = '\r\x1b[K'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const DEFAULT_INTERVAL_MS = 90

/**
 * What the pane is doing. Deliberately narrower than HRC's `ViewerState`: the
 * broker event vocabulary has no `turn.awaiting_input` (that is an HRC-level
 * concept), so there is no honest `awaiting` state to project here.
 */
export type StatusLineState = 'running' | 'idle' | 'exited'

/**
 * Project one broker event type onto the status-line state, or null when the
 * event carries no state meaning.
 *
 * This agrees with HRC's canonical status-bar projection
 * (`viewerStateForEventKind`, hrc-server/src/headless-viewer-status.ts) wherever
 * the two vocabularies overlap, so the pane row and the window status bar can
 * never disagree about whether the session is working. The broker-only additions
 * are `turn.retry` (a retried turn is still running) and the `invocation.*`
 * terminals, which stand in for HRC's `runtime.*` ones.
 */
export function statusLineStateForEventType(type: string): StatusLineState | null {
  switch (type) {
    case 'turn.started':
    case 'turn.retry':
      return 'running'
    case 'turn.completed':
    case 'turn.failed':
    case 'turn.interrupted':
      return 'idle'
    case 'invocation.exited':
    case 'invocation.failed':
      return 'exited'
    default:
      return null
  }
}

export interface StatusLineOptions {
  /** Raw pane writer. Receives partial rows — must NOT append newlines. */
  write: (chunk: string) => void
  /** Render one frame. Supplied by `createCodexStatusRow` in production. */
  renderRow: (frame: number, elapsedMs: number) => string
  /**
   * Master switch. False on a non-TTY (tests, pipes, `lines()` projections),
   * where cursor control would be corruption rather than animation. Transcript
   * lines still write through untouched.
   */
  enabled?: boolean | undefined
  intervalMs?: number | undefined
  now?: (() => number) | undefined
  schedule?: ((fn: () => void, ms: number) => unknown) | undefined
  clearScheduled?: ((handle: unknown) => void) | undefined
}

export interface StatusLine {
  /** Commit one transcript line, keeping the status row below it. */
  writeLine: (line: string) => void
  /** Fold in one broker event; drives the state machine. */
  observe: (event: { type: string }) => void
  /**
   * Declare that the pane was cleared by someone else, so the row is no longer on
   * screen (a resize redraw). Without this the next write would erase a row that is
   * gone — landing a stray erase on whatever now occupies the cursor's row.
   */
  invalidate: () => void
  /** Stop animating, erase the row, restore the cursor. Idempotent. */
  dispose: () => void
}

export function createStatusLine(options: StatusLineOptions): StatusLine {
  const enabled = options.enabled ?? true
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = options.now ?? ((): number => Date.now())
  const schedule = options.schedule ?? ((fn, ms): unknown => setInterval(fn, ms))
  const clearScheduled =
    options.clearScheduled ??
    ((handle): void => clearInterval(handle as ReturnType<typeof setInterval>))

  let state: StatusLineState = 'idle'
  /** True while the row occupies the physical row under the cursor. */
  let painted = false
  let frame = 0
  let startedAt = 0
  let timer: unknown
  let cursorHidden = false
  let disposed = false

  function paint(): void {
    if (!enabled || disposed || state !== 'running') return
    // The cursor is hidden only once a row is actually going to be drawn, so a
    // non-running renderer never touches the operator's cursor at all.
    if (!cursorHidden) {
      options.write(HIDE_CURSOR)
      cursorHidden = true
    }
    options.write(`${ERASE_ROW}${options.renderRow(frame, now() - startedAt)}`)
    painted = true
  }

  function erase(): void {
    if (!painted) return
    options.write(ERASE_ROW)
    painted = false
  }

  function restoreCursor(): void {
    if (!cursorHidden) return
    options.write(SHOW_CURSOR)
    cursorHidden = false
  }

  function stopTimer(): void {
    if (timer === undefined) return
    clearScheduled(timer)
    timer = undefined
  }

  function startTimer(): void {
    if (!enabled || disposed || timer !== undefined) return
    timer = schedule(() => {
      frame += 1
      paint()
    }, intervalMs)
  }

  return {
    writeLine(line: string): void {
      // The invariant, in three statements: the row never survives a commit, the
      // committed text is untouched, and the row comes back below it.
      erase()
      options.write(`${line}\n`)
      paint()
    },

    observe(event: { type: string }): void {
      const next = statusLineStateForEventType(event.type)
      if (next === null || disposed) return
      // Terminal is sticky, matching HRC's projector: once the invocation is gone
      // a late-arriving `turn.started` from replay must not resurrect the row.
      if (state === 'exited') return

      if (next === 'running') {
        // Only restart the clock on an idle→running edge. A `turn.retry` inside a
        // live turn keeps counting from the original start, which is the elapsed
        // the operator is actually waiting on.
        if (state !== 'running') {
          startedAt = now()
          frame = 0
        }
        state = 'running'
        startTimer()
        paint()
        return
      }

      state = next
      stopTimer()
      erase()
      restoreCursor()
    },

    invalidate(): void {
      // The cells are already gone; writing an erase for them would corrupt the
      // freshly cleared pane. Drop the claim, keep the state and the clock.
      painted = false
      cursorHidden = false
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      stopTimer()
      erase()
      restoreCursor()
    },
  }
}
