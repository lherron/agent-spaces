/**
 * T-06365 / T-07906 — the live ephemeral FOOTER at the foot of the Codex
 * app-server pane.
 *
 * The transcript is an append-only, multi-turn scrollback stream: it commits each
 * event as it finalizes and never redraws. That is the right model for history,
 * but it means a turn that is thinking — or running a long tool — prints nothing,
 * and the operator cannot tell a working session from a wedged one. It also means
 * a submission WAITING in the broker queue has nowhere to live: it is not history
 * yet, and by the time it becomes history it is no longer waiting.
 *
 * This module adds the one thing the transcript deliberately is not: an EPHEMERAL
 * block of rows, repainted in place, that exists only while it has something to
 * say. It is not part of the transcript and never reaches scrollback. The
 * discipline that guarantees that is a single rule — the block is erased before any
 * transcript line is committed, and repainted after — so the committed stream is
 * byte-identical to what it would be with no footer at all.
 *
 * The block is at most two regions, painted as one unit because this technique can
 * only own one contiguous run of rows at the cursor:
 *
 *   ┌ running row  — one row, animated, present only mid-turn (T-06365)
 *   └ queue drawer — zero or more rows, the submissions still waiting (T-07906)
 *
 * Cursor discipline, and why it generalizes from one row to N: at rest the cursor
 * is parked at column 0 of the block's FIRST row, and `paintedHeight` records how
 * many rows the block last occupied. Erasing walks down that many rows clearing
 * each, then walks back up; painting writes the rows and walks back up. At N=1
 * both collapse to the original three bytes (`\r\x1b[K`) with no vertical movement
 * at all, so the single-row behaviour is byte-identical to what it always was.
 *
 * The one hard requirement this places on row content: a footer row must NEVER
 * wrap. A wrapped row occupies two physical rows and every cursor-up count below
 * is then wrong, which walks an erase onto committed transcript. `transcript.ts`
 * clips every band one column short of the pane for exactly this reason.
 *
 * Ownership split: `transcript.ts` owns what the rows LOOK like (they are forge
 * lanes like every other band); this module owns WHEN they paint and the cursor
 * mechanics that keep them out of history. The clock is injectable, so the frame
 * sequence is testable without a TTY or a real timer.
 */

/**
 * Erase from the cursor to the end of the physical row; does not move the cursor.
 * With a leading `\r` this is the original single-row trick in three bytes, and it
 * is still the whole of the erase at any height — the rest is only walking.
 */
const ERASE_TO_EOL = '\x1b[K'
const CURSOR_DOWN = '\x1b[B'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const DEFAULT_INTERVAL_MS = 90
/**
 * Repaint cadence when the block is up but no turn is running — a drawer holding
 * queued submissions with nothing but their age changing. The running row's 90ms
 * exists to animate; an age rendered in whole seconds needs a second.
 */
const DEFAULT_IDLE_INTERVAL_MS = 1000

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

/** The minimum an observed event must carry. Real callers pass the full envelope. */
export interface StatusLineObservedEvent {
  type: string
  payload?: unknown
}

export interface StatusLineOptions {
  /** Raw pane writer. Receives partial rows — must NOT append newlines. */
  write: (chunk: string) => void
  /**
   * Render the running row. Supplied by `createCodexStatusRow` in production.
   * `note` carries a stall annotation when the broker has reported no progress.
   */
  renderRow: (frame: number, elapsedMs: number, note?: string | undefined) => string
  /**
   * Render the queue drawer: zero or more rows painted BELOW the running row.
   * Called fresh on every frame, so the caller may fold live queue state into it
   * without telling this module anything about submissions.
   */
  renderDrawer?: (() => string[]) | undefined
  /**
   * Largest number of physical rows the footer may occupy. A last-resort guard
   * against a block taller than the pane, which cannot be erased. Resolved fresh
   * per paint so a resize is picked up.
   */
  maxHeight?: (() => number | undefined) | undefined
  /**
   * Master switch. False on a non-TTY (tests, pipes, `lines()` projections),
   * where cursor control would be corruption rather than animation. Transcript
   * lines still write through untouched.
   */
  enabled?: boolean | undefined
  intervalMs?: number | undefined
  idleIntervalMs?: number | undefined
  now?: (() => number) | undefined
  schedule?: ((fn: () => void, ms: number) => unknown) | undefined
  clearScheduled?: ((handle: unknown) => void) | undefined
}

export interface StatusLine {
  /** Commit one transcript line, keeping the footer below it. */
  writeLine: (line: string) => void
  /** Fold in one broker event; drives the state machine. */
  observe: (event: StatusLineObservedEvent) => void
  /**
   * Repaint now. For state the footer renders but this module does not own — the
   * queue drawer changing between events, or a caller-side clock tick.
   */
  refresh: () => void
  /**
   * Declare that the pane was cleared by someone else, so the block is no longer on
   * screen (a resize redraw). Without this the next write would erase rows that are
   * gone — landing a stray erase on whatever now occupies the cursor's row.
   */
  invalidate: () => void
  /** Stop animating, erase the block, restore the cursor. Idempotent. */
  dispose: () => void
}

/**
 * A stall annotation for the running row, or undefined when the turn is making
 * progress. The broker reports a stall as a threshold crossing rather than a
 * level, and there is no `turn.unstalled`: ANY later event on the invocation is
 * the evidence that output resumed, which is exactly how this is cleared.
 */
function stallNoteFor(event: StatusLineObservedEvent): string | undefined {
  if (event.type !== 'turn.stalled') return undefined
  const payload = (event.payload ?? {}) as { noProgressMs?: unknown }
  const ms = typeof payload.noProgressMs === 'number' ? payload.noProgressMs : undefined
  if (ms === undefined || !Number.isFinite(ms)) return 'unknown'
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}

export function createStatusLine(options: StatusLineOptions): StatusLine {
  const enabled = options.enabled ?? true
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS
  const now = options.now ?? ((): number => Date.now())
  const schedule = options.schedule ?? ((fn, ms): unknown => setInterval(fn, ms))
  const clearScheduled =
    options.clearScheduled ??
    ((handle): void => clearInterval(handle as ReturnType<typeof setInterval>))

  let state: StatusLineState = 'idle'
  /** How many physical rows the block occupies, with the cursor parked at its top. */
  let paintedHeight = 0
  let frame = 0
  let startedAt = 0
  let timer: unknown
  let timerIntervalMs: number | undefined
  let cursorHidden = false
  let disposed = false
  let stallNote: string | undefined

  /** The block as it should look right now: running row first, drawer beneath. */
  function footerRows(): string[] {
    if (!enabled || disposed) return []
    const rows: string[] = []
    if (state === 'running') rows.push(options.renderRow(frame, now() - startedAt, stallNote))
    if (options.renderDrawer !== undefined) rows.push(...options.renderDrawer())
    const cap = options.maxHeight?.()
    if (cap !== undefined && Number.isFinite(cap) && rows.length > Math.max(0, cap)) {
      return rows.slice(0, Math.max(0, cap))
    }
    return rows
  }

  /**
   * Clear the block and park the cursor at column 0 of where its first row was.
   * At N=1 this is the original `\r\x1b[K` and nothing else, so the single-row
   * write sequence is unchanged.
   */
  function erase(): void {
    if (paintedHeight === 0) return
    let out = '\r'
    for (let i = 0; i < paintedHeight; i += 1) {
      out += ERASE_TO_EOL
      if (i < paintedHeight - 1) out += CURSOR_DOWN
    }
    if (paintedHeight > 1) out += `\x1b[${paintedHeight - 1}A`
    options.write(out)
    paintedHeight = 0
  }

  function restoreCursor(): void {
    if (!cursorHidden) return
    options.write(SHOW_CURSOR)
    cursorHidden = false
  }

  function paint(): void {
    if (!enabled || disposed) return
    const rows = footerRows()
    if (rows.length === 0) {
      erase()
      restoreCursor()
      return
    }
    // The cursor is hidden only once a row is actually going to be drawn, so a
    // pane with nothing to show never touches the operator's cursor at all.
    if (!cursorHidden) {
      options.write(HIDE_CURSOR)
      cursorHidden = true
    }
    // A block that SHRANK leaves rows below the new last one; clearing per-row on
    // the way down cannot reach them. A same-or-taller block is fully covered by
    // the per-row erase, which keeps the N=1 repaint a single write as before.
    if (paintedHeight > rows.length) erase()
    let out = '\r'
    rows.forEach((row, index) => {
      out += `${ERASE_TO_EOL}${row}`
      if (index < rows.length - 1) out += '\n'
    })
    if (rows.length > 1) out += `\x1b[${rows.length - 1}A\r`
    options.write(out)
    paintedHeight = rows.length
  }

  function stopTimer(): void {
    if (timer === undefined) return
    clearScheduled(timer)
    timer = undefined
    timerIntervalMs = undefined
  }

  /**
   * The block animates at the running row's cadence while a turn is live, ticks
   * once a second while only the drawer is up (ages advance), and stops entirely
   * when there is nothing to paint.
   */
  function ensureTimer(): void {
    if (!enabled || disposed) return
    const wanted =
      state === 'running' ? intervalMs : footerRows().length > 0 ? idleIntervalMs : undefined
    if (wanted === undefined) {
      stopTimer()
      return
    }
    if (timer !== undefined && timerIntervalMs === wanted) return
    stopTimer()
    timerIntervalMs = wanted
    timer = schedule(() => {
      frame += 1
      paint()
    }, wanted)
  }

  return {
    writeLine(line: string): void {
      // The invariant, in three statements: the block never survives a commit, the
      // committed text is untouched, and the block comes back below it.
      erase()
      options.write(`${line}\n`)
      paint()
    },

    observe(event: StatusLineObservedEvent): void {
      if (disposed) return
      const next = statusLineStateForEventType(event.type)
      // Terminal is sticky, matching HRC's projector: once the invocation is gone
      // a late-arriving `turn.started` from replay must not resurrect the row.
      if (state === 'exited') return

      // A stall is a threshold crossing, not a level: any subsequent event is the
      // proof that output resumed. Read before the state machine so a stall
      // arriving with no state meaning still annotates the row.
      stallNote = stallNoteFor(event)

      if (next === 'running') {
        // Only restart the clock on an idle→running edge. A `turn.retry` inside a
        // live turn keeps counting from the original start, which is the elapsed
        // the operator is actually waiting on.
        if (state !== 'running') {
          startedAt = now()
          frame = 0
        }
        state = 'running'
      } else if (next !== null) {
        state = next
      }

      ensureTimer()
      paint()
    },

    refresh(): void {
      if (disposed) return
      ensureTimer()
      paint()
    },

    invalidate(): void {
      // The cells are already gone; writing an erase for them would corrupt the
      // freshly cleared pane. Drop the claim, keep the state and the clock.
      paintedHeight = 0
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
