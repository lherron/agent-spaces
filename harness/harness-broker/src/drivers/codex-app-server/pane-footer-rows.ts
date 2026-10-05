/** The pane's ephemeral footer rows: the live running row and the queue drawer. */
import {
  type CodexFg,
  type CodexSeg,
  type CodexTranscriptWidth,
  createCodexStyler,
} from './pane-style'
import { formatLiveElapsed } from './pane-time'
import { type QueueDrawerEntry, shortSubmissionId } from './queue-drawer'

/**
 * The live "running" status row (T-06365).
 *
 * Structurally this is the UNRESOLVED form of the `✓ done` turn footer: same lane
 * position at the foot of the turn, replaced in place by the footer the moment the
 * turn lands. So it is a real band, and it takes the molten accent the turn divider
 * already owns — `▶ turn` opens the turn, this holds it open, `✓ done` closes it.
 *
 * The animation is a bar of metal in a fire rather than the braille dots every CLI
 * spinner reaches for: a white-hot coal breathes back and forth along `━━━━━━`, and
 * the cells behind it cool through molten → brass → dead ember. It ping-pongs
 * instead of marching in one direction — a conveyor reads as progress toward a
 * known end, and a turn has no known end. Heat only says "still working".
 */
export interface CodexStatusRow {
  /**
   * One frame of the running row. `frame` is taken modulo the frame count.
   *
   * `note` is the stall annotation (T-07906). A stall is the answer to the only
   * question this row exists to answer — "is it working or is it wedged?" — so it
   * belongs ON the repainting row, not committed once per heartbeat into
   * scrollback where it would flood the pane with the absence of news.
   */
  running: (frame: number, elapsedMs: number, note?: string | undefined) => string
}

const EMBER_CELLS = 6
const EMBER_GLYPH = '━'
/** Heat by distance behind the coal: white-hot, molten, brass, then dead ember. */
const EMBER_HEAT: readonly CodexFg[] = ['hot', 'molten', 'brass', 'ember']
/** Ping-pong period: out along the bar and back, with no held frame at either end. */
export const CODEX_STATUS_FRAME_COUNT = (EMBER_CELLS - 1) * 2

export function createCodexStatusRow(options: {
  color?: boolean | undefined
  width?: CodexTranscriptWidth | undefined
}): CodexStatusRow {
  const styler = createCodexStyler(options.color ?? false, options.width)
  return {
    running(frame: number, elapsedMs: number, note?: string | undefined): string {
      const phase =
        ((frame % CODEX_STATUS_FRAME_COUNT) + CODEX_STATUS_FRAME_COUNT) % CODEX_STATUS_FRAME_COUNT
      const coal = phase < EMBER_CELLS ? phase : CODEX_STATUS_FRAME_COUNT - phase
      const bar: CodexSeg[] = Array.from({ length: EMBER_CELLS }, (_, i) => ({
        text: EMBER_GLYPH,
        fg: EMBER_HEAT[Math.min(Math.abs(i - coal), EMBER_HEAT.length - 1)] as CodexFg,
        bold: Math.abs(i - coal) <= 1,
      }))
      const elapsed = formatLiveElapsed(elapsedMs)
      const stalled = note !== undefined && note.length > 0
      return styler.band('forge', 'molten', [
        ...bar,
        { text: stalled ? '  stalled' : '  running', fg: stalled ? 'brass' : 'text', bold: true },
        ...(elapsed.length > 0 ? [{ text: ` · ${elapsed}`, fg: 'dim' as CodexFg }] : []),
        ...(stalled ? [{ text: ` · no output ${note}`, fg: 'brass' as CodexFg }] : []),
      ])
    },
  }
}

/**
 * The queue drawer rows (T-07906).
 *
 * These are the submissions still WAITING, painted in the ephemeral footer under
 * the running row. They take the violet input lane, because that is what they are:
 * user input that has arrived at the broker and not yet reached the model. When one
 * drains, the transcript commits the real `❯` input band above in the same lane —
 * so a message visibly moves UP out of the drawer into history rather than
 * appearing from nowhere.
 *
 * Nothing here can show the message text: no admission or queue payload carries a
 * body (see `queue-drawer.ts`). Sender and wait are what the pane honestly knows.
 */
export interface CodexQueueDrawerRow {
  rows: (entries: readonly QueueDrawerEntry[], nowMs: number) => string[]
}

/** Rows the drawer will show in full before collapsing the rest into a count. */
const MAX_DRAWER_ENTRIES = 5
/**
 * Below this much TTL remaining, the countdown is shown. Above it, it is not: a
 * live `ttl 27m` on every row is clutter that says nothing, whereas `ttl 3m` is
 * the pane telling you this message is about to be dropped undelivered.
 */
const TTL_WARN_MS = 5 * 60 * 1000

export function createCodexQueueDrawerRow(options: {
  color?: boolean | undefined
  width?: CodexTranscriptWidth | undefined
}): CodexQueueDrawerRow {
  const styler = createCodexStyler(options.color ?? false, options.width)

  function entryRow(entry: QueueDrawerEntry, nowMs: number): string {
    const waited = formatLiveElapsed(nowMs - entry.enqueuedAtMs)
    const remainingMs =
      entry.ttlMs !== undefined ? entry.ttlMs - (nowMs - entry.enqueuedAtMs) : undefined
    const expiring =
      remainingMs !== undefined && remainingMs > 0 && remainingMs <= TTL_WARN_MS
        ? formatLiveElapsed(remainingMs)
        : ''
    return styler.band('prompt', 'iris', [
      { text: '  ', fg: 'dim' },
      { text: shortSubmissionId(entry.submissionId), fg: 'text', bold: true },
      { text: ` · ${entry.principal}`, fg: 'muted' },
      ...(entry.class !== 'queue' ? [{ text: ` · ${entry.class}`, fg: 'brass' as CodexFg }] : []),
      ...(waited.length > 0 ? [{ text: ` · ${waited}`, fg: 'dim' as CodexFg }] : []),
      ...(expiring.length > 0 ? [{ text: ` · ttl ${expiring}`, fg: 'brass' as CodexFg }] : []),
    ])
  }

  return {
    rows(entries: readonly QueueDrawerEntry[], nowMs: number): string[] {
      if (entries.length === 0) return []
      const shown = entries.slice(0, MAX_DRAWER_ENTRIES)
      const hidden = entries.length - shown.length
      return [
        styler.band('prompt', 'iris', [
          { text: '⋯ waiting', fg: 'iris', bold: true },
          { text: ` · ${entries.length}`, fg: 'dim' },
        ]),
        ...shown.map((entry) => entryRow(entry, nowMs)),
        ...(hidden > 0
          ? [styler.band('prompt', 'iris', [{ text: `  … ${hidden} more waiting`, fg: 'dim' }])]
          : []),
      ]
    },
  }
}
