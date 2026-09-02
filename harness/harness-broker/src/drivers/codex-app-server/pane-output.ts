import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createQueueDrawer } from './queue-drawer'
import { type StatusLine, createStatusLine } from './status-line'
import {
  type CodexTranscriptWidth,
  createCodexQueueDrawerRow,
  createCodexStatusRow,
} from './transcript'

/**
 * T-07906 — the pane's EPHEMERAL surface, assembled once.
 *
 * Two callers need the identical wiring: `renderer-entry.ts`, which runs in the
 * leased tmux pane against a live broker, and `scripts/replay-broker-pane.ts`,
 * which runs the same renderer over a recorded ledger. Building it twice would
 * mean the replay harness validates a lookalike of the pane rather than the pane
 * — the failure mode where a double agrees with your own mistake. So the wiring
 * lives here and both callers take it whole.
 *
 * What it assembles: the transcript projection's `sink` (every committed line) and
 * `onEvent` (every event, in seq order, once) are joined to the ephemeral footer —
 * the animated running row plus the queue drawer — such that the footer is always
 * erased before a line is committed and repainted after.
 */

export interface PaneOutputOptions {
  /** Raw pane writer. Receives partial rows — must NOT append newlines. */
  write: (chunk: string) => void
  /**
   * TTY gate for the footer. Cursor control off a TTY is corruption, not
   * animation; committed transcript lines still write through untouched.
   */
  enabled: boolean
  color?: boolean | undefined
  width?: CodexTranscriptWidth | undefined
  /** Rows available in the pane, so the footer can never grow taller than it. */
  height?: (() => number | undefined) | undefined
  /**
   * Clock for drawer ages. Injectable so a replay can run on the recorded
   * timeline instead of wall-clock, where every entry would read as hours old.
   */
  now?: (() => number) | undefined
  intervalMs?: number | undefined
  schedule?: ((fn: () => void, ms: number) => unknown) | undefined
  clearScheduled?: ((handle: unknown) => void) | undefined
}

export interface PaneOutput {
  /** Pass as the projection's `sink`. */
  sink: (line: string) => void
  /** Pass as the projection's `onEvent`. */
  onEvent: (event: InvocationEventEnvelope) => void
  /** Repaint now — for a caller-side clock tick with no new event. */
  refresh: () => void
  /** The pane was cleared by someone else (a resize redraw). */
  invalidate: () => void
  dispose: () => void
  /** Exposed for tests that assert footer mechanics directly. */
  statusLine: StatusLine
}

/**
 * The footer must leave room for the conversation. A block that fills the pane
 * cannot be erased without walking over committed transcript, so it is capped
 * well short of the height and the drawer collapses its own overflow into a count.
 */
const FOOTER_HEIGHT_HEADROOM = 4

export function createPaneOutput(options: PaneOutputOptions): PaneOutput {
  const now = options.now ?? ((): number => Date.now())
  const statusRow = createCodexStatusRow({
    ...(options.color !== undefined ? { color: options.color } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
  })
  const drawerRow = createCodexQueueDrawerRow({
    ...(options.color !== undefined ? { color: options.color } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
  })
  const drawer = createQueueDrawer()

  const statusLine = createStatusLine({
    write: options.write,
    renderRow: (frame, elapsedMs, note) => statusRow.running(frame, elapsedMs, note),
    renderDrawer: () => drawerRow.rows(drawer.entries(), now()),
    maxHeight: () => {
      const rows = options.height?.()
      if (rows === undefined || !Number.isFinite(rows)) return undefined
      return Math.max(1, rows - FOOTER_HEIGHT_HEADROOM)
    },
    enabled: options.enabled,
    now,
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    ...(options.clearScheduled !== undefined ? { clearScheduled: options.clearScheduled } : {}),
  })

  return {
    sink: (line) => statusLine.writeLine(line),
    onEvent: (event) => {
      // The drawer folds FIRST, so the repaint that `observe` performs already
      // reflects this event's effect on the queue rather than lagging it by one.
      drawer.observe(event)
      statusLine.observe(event)
    },
    refresh: () => statusLine.refresh(),
    invalidate: () => statusLine.invalidate(),
    dispose: () => statusLine.dispose(),
    statusLine,
  }
}
