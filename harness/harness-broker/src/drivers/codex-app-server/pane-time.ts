/** Pane timestamps and durations, always from the event's own time. */

/**
 * Wall-clock zone for the turn-end band. An operator returning to a cold pane
 * reads it against the clock on their own wall, so the zone is the operator's,
 * not the machine's — and it is fixed here rather than configurable, because a
 * pane whose stamps mean a different hour on a different host is worse than one
 * that is occasionally an hour off for a traveller.
 */
const PANE_CLOCK_TIME_ZONE = 'America/Chicago'

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s - m * 60)}s`
}

const PANE_CLOCK_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: PANE_CLOCK_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

/**
 * `hh:mm AM/PM` on the operator's wall clock, from the event's OWN timestamp —
 * never `Date.now()`, so a replayed ledger stamps the band with the hour the
 * turn actually ended rather than the hour it was replayed. Absent or
 * unparseable time renders nothing, the same posture as `formatElapsed`.
 */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  // Intl separates the day period with U+202F on modern ICU; the pane's width
  // accounting and the tests both want an ordinary space.
  return PANE_CLOCK_FORMAT.format(new Date(ms)).replace(/[\u202f\u00a0]/g, ' ')
}

const PANE_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: PANE_CLOCK_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

/**
 * `Thu, Sep 4` on the operator's wall calendar, from the event's OWN timestamp
 * (T-07994). A bare `08:06 PM` is ambiguous the moment a pane's scrollback — or
 * a replay of a recorded ledger — crosses midnight, so the calendar date is
 * carried by a divider row. Same posture as `formatClock`: never `Date.now()`,
 * and an absent or unparseable time renders nothing.
 */
export function formatPaneDate(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  return PANE_DATE_FORMAT.format(new Date(ms)).replace(/[\u202f\u00a0]/g, ' ')
}

export function parseMs(time: unknown): number {
  if (typeof time !== 'string') return Number.NaN
  return Date.parse(time)
}

/**
 * Elapsed for a row that repaints several times a second (T-06365). Deliberately
 * NOT `formatElapsed`: that renders sub-second precision, which on a live counter
 * churns every frame and reads as noise rather than a stopwatch. Whole seconds
 * only, and nothing at all under one second — a turn that finishes that fast
 * should not flash a number on its way past.
 */
export function formatLiveElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}
