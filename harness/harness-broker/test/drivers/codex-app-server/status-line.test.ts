import { describe, expect, test } from 'bun:test'
import {
  type StatusLine,
  createStatusLine,
  statusLineStateForEventType,
} from '../../../src/drivers/codex-app-server/status-line'
import {
  CODEX_STATUS_FRAME_COUNT,
  createCodexStatusRow,
} from '../../../src/drivers/codex-app-server/transcript'

const ERASE_ROW = '\r\x1b[K'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

/**
 * Strip every SGR/CSI sequence, leaving the cells the operator actually sees.
 * The pattern is BUILT from an escaped ESC rather than written as a regex literal,
 * which would need a raw control character in the source (and the lint that
 * forbids that is right — it is unreadable and easy to get subtly wrong).
 */
const CSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, 'g')

function visibleCells(row: string): string {
  return row.replace(CSI_PATTERN, '')
}

/**
 * A fake pane. Captures the raw byte stream so the tests can assert on what the
 * terminal actually receives — the status row is cursor mechanics, so the bytes
 * ARE the behaviour and a line-level view would hide the whole point.
 */
function harness(overrides: { enabled?: boolean } = {}): {
  status: StatusLine
  chunks: string[]
  tick: (times?: number) => void
  clock: { advance: (ms: number) => void }
  committed: () => string[]
} {
  const chunks: string[] = []
  let ticker: (() => void) | undefined
  let ms = 1_000

  const status = createStatusLine({
    write: (chunk) => chunks.push(chunk),
    renderRow: (frame, elapsedMs) => `<row frame=${frame} elapsed=${elapsedMs}>`,
    enabled: overrides.enabled ?? true,
    now: () => ms,
    schedule: (fn) => {
      ticker = fn
      return 1
    },
    clearScheduled: () => {
      ticker = undefined
    },
  })

  return {
    status,
    chunks,
    tick: (times = 1) => {
      for (let i = 0; i < times; i++) ticker?.()
    },
    clock: {
      advance: (delta: number): void => {
        ms += delta
      },
    },
    /**
     * Reconstruct the SCROLLBACK: the cells a terminal would keep. Everything the
     * status row writes is erased before the next newline, so replaying the stream
     * through the erase rule must yield exactly the transcript lines.
     *
     * Cursor show/hide is dropped first: it occupies no cell, so a terminal keeps
     * nothing for it, and leaving it in would make the harness — not the renderer —
     * the thing that fails.
     */
    committed: () => {
      const stream = chunks.join('').replaceAll(HIDE_CURSOR, '').replaceAll(SHOW_CURSOR, '')
      return stream
        .split('\n')
        .slice(0, -1)
        .map((row) => {
          const lastErase = row.lastIndexOf(ERASE_ROW)
          return lastErase === -1 ? row : row.slice(lastErase + ERASE_ROW.length)
        })
    },
  }
}

describe('codex-app-server status line — state projection (T-06365)', () => {
  test('agrees with the HRC status-bar vocabulary where the two overlap', () => {
    expect(statusLineStateForEventType('turn.started')).toBe('running')
    expect(statusLineStateForEventType('turn.completed')).toBe('idle')
    // Broker-only additions: a retried turn is still working; the invocation
    // terminals stand in for HRC's runtime.* ones.
    expect(statusLineStateForEventType('turn.retry')).toBe('running')
    expect(statusLineStateForEventType('turn.failed')).toBe('idle')
    expect(statusLineStateForEventType('turn.interrupted')).toBe('idle')
    expect(statusLineStateForEventType('invocation.exited')).toBe('exited')
    expect(statusLineStateForEventType('invocation.failed')).toBe('exited')
  })

  test('events with no state meaning leave the row alone', () => {
    expect(statusLineStateForEventType('tool.call.started')).toBeNull()
    expect(statusLineStateForEventType('assistant.message.delta')).toBeNull()
    expect(statusLineStateForEventType('usage.updated')).toBeNull()
  })
})

describe('codex-app-server status line — scrollback purity (T-06365)', () => {
  test('the row never reaches scrollback: the committed stream is exactly the transcript lines', () => {
    const h = harness()
    h.status.writeLine('before the turn')
    h.status.observe({ type: 'turn.started' })
    h.tick(3)
    h.status.writeLine('a tool band mid-turn')
    h.tick(2)
    h.status.writeLine('another line mid-turn')
    h.status.observe({ type: 'turn.completed' })
    h.status.writeLine('✓ done')

    expect(h.committed()).toEqual([
      'before the turn',
      'a tool band mid-turn',
      'another line mid-turn',
      '✓ done',
    ])
  })

  test('every transcript line is preceded by an erase while the row is live', () => {
    const h = harness()
    h.status.observe({ type: 'turn.started' })
    h.chunks.length = 0
    h.status.writeLine('mid-turn line')
    // Erase the row, commit the line, repaint below it — in that order.
    expect(h.chunks[0]).toBe(ERASE_ROW)
    expect(h.chunks[1]).toBe('mid-turn line\n')
    expect(h.chunks[2]).toContain('<row frame=')
  })

  test('when idle, a line is committed with no cursor control at all', () => {
    const h = harness()
    h.status.writeLine('quiet line')
    expect(h.chunks).toEqual(['quiet line\n'])
  })
})

describe('codex-app-server status line — lifecycle (T-06365)', () => {
  test('animates only while running, and erases the row and restores the cursor on idle', () => {
    const h = harness()
    h.status.observe({ type: 'turn.started' })
    expect(h.chunks[0]).toBe(HIDE_CURSOR)
    h.tick(2)
    expect(h.chunks.join('')).toContain('<row frame=2')

    h.chunks.length = 0
    h.status.observe({ type: 'turn.completed' })
    expect(h.chunks).toEqual([ERASE_ROW, SHOW_CURSOR])

    // The timer is cleared: a stray tick after idle must not repaint.
    h.tick(5)
    expect(h.chunks).toEqual([ERASE_ROW, SHOW_CURSOR])
  })

  test('counts elapsed from the turn start, and a retry keeps the original clock', () => {
    const h = harness()
    h.status.observe({ type: 'turn.started' })
    h.clock.advance(5_000)
    h.tick()
    expect(h.chunks.join('')).toContain('elapsed=5000')

    // A retry inside a live turn is still the same wait from the operator's side.
    h.status.observe({ type: 'turn.retry' })
    h.clock.advance(1_000)
    h.tick()
    expect(h.chunks.join('')).toContain('elapsed=6000')
  })

  test('a fresh turn restarts the clock', () => {
    const h = harness()
    h.status.observe({ type: 'turn.started' })
    h.clock.advance(5_000)
    h.status.observe({ type: 'turn.completed' })
    h.clock.advance(30_000)
    h.status.observe({ type: 'turn.started' })
    h.tick()
    expect(h.chunks.join('')).toContain('elapsed=0')
  })

  test('exited is sticky: a replayed turn.started can never resurrect the row', () => {
    const h = harness()
    h.status.observe({ type: 'invocation.exited' })
    h.chunks.length = 0
    h.status.observe({ type: 'turn.started' })
    h.tick(3)
    expect(h.chunks).toEqual([])
  })

  test('dispose erases the row, restores the cursor, and is idempotent', () => {
    const h = harness()
    h.status.observe({ type: 'turn.started' })
    h.chunks.length = 0
    h.status.dispose()
    expect(h.chunks).toEqual([ERASE_ROW, SHOW_CURSOR])
    h.status.dispose()
    expect(h.chunks).toEqual([ERASE_ROW, SHOW_CURSOR])
    // A tick after dispose must not repaint.
    h.tick(3)
    expect(h.chunks).toEqual([ERASE_ROW, SHOW_CURSOR])
  })

  test('disabled (non-TTY) writes transcript lines and nothing else', () => {
    const h = harness({ enabled: false })
    h.status.observe({ type: 'turn.started' })
    h.status.writeLine('a line')
    h.tick(3)
    expect(h.chunks).toEqual(['a line\n'])
  })
})

describe('codex-app-server status row — the ember bar (T-06365)', () => {
  const row = createCodexStatusRow({ color: true, width: () => 80 })
  // Foreground SGRs as `paint` actually emits them: intensity is ALWAYS re-asserted
  // alongside the colour, so a bare `\x1b[38;2;...` never appears on the wire.
  const HOT = '38;2;255;226;168'
  const MOLTEN = '38;2;242;107;30'
  const BRASS = '38;2;224;168;46'
  const EMBER = '38;2;122;56;22'

  test('renders as a forge lane: molten keyline, molten band tint, erase-to-EOL fill', () => {
    const frame = row.running(0, 0)
    expect(frame).toContain('\x1b[48;2;44;24;12m') // forge band tint
    expect(frame).toContain('▎') // the signature keyline
    expect(frame).toContain('running')
    expect(frame).toContain('\x1b[K') // fills to the true pane edge (T-06343)
    expect(frame.endsWith('\x1b[0m')).toBe(true)
  })

  test('the coal ping-pongs rather than marching, so it reads as heat, not progress', () => {
    // The white-hot cell's position across one full period: out along the bar and
    // back, with no frame held at either end.
    const positions = Array.from({ length: CODEX_STATUS_FRAME_COUNT }, (_, f) => {
      const cells = row.running(f, 0).split('━')
      return cells.findIndex((cell) => cell.includes(HOT))
    })
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1])
  })

  test('the frame index wraps, so a long turn animates forever', () => {
    expect(row.running(CODEX_STATUS_FRAME_COUNT, 0)).toBe(row.running(0, 0))
    expect(row.running(CODEX_STATUS_FRAME_COUNT * 7 + 3, 0)).toBe(row.running(3, 0))
  })

  test('cells cool with distance behind the coal', () => {
    // Coal parked at cell 0, so the ramp runs left to right across the whole bar.
    const cells = row.running(0, 0).split('━').slice(0, 6)
    expect(cells[0]).toContain(HOT) // the coal itself
    expect(cells[1]).toContain(MOLTEN) // one cell behind
    expect(cells[2]).toContain(BRASS) // two behind
    expect(cells[3]).toContain(EMBER) // cooled out
    expect(cells[4]).toContain(EMBER) // and stays cool
  })

  test('elapsed appears only once it is worth reading, and never churns sub-second', () => {
    expect(row.running(0, 0)).not.toContain('·')
    expect(row.running(0, 999)).not.toContain('·')
    expect(row.running(0, 1_000)).toContain('· 1s')
    expect(row.running(0, 12_400)).toContain('· 12s')
    expect(row.running(0, 63_000)).toContain('· 1m3s')
  })

  test('stays far short of the narrowest pane, so it can never wrap away its keyline', () => {
    // A wrapped row would split the keyline onto its own physical line and land the
    // erase-to-EOL on the wrong one. The row is a fixed short measure and the pane
    // width floors at MIN_WIDTH (48), so the band's clip can never actually bite —
    // this pins that headroom rather than the clip itself (covered for bands
    // generally by the T-06343 cases in renderer.red.test.ts).
    expect(visibleCells(row.running(0, 90_000)).length).toBeLessThan(48 - 1)
  })

  test('reads the pane width per frame, so a resize mid-turn cannot pin the fill', () => {
    // The fill is erase-to-EOL, so width never appears in the row's bytes — what
    // matters is that the thunk is consulted on EVERY frame rather than snapshotted
    // at construction (T-06343).
    const widths: number[] = []
    const resizing = createCodexStatusRow({
      color: true,
      width: () => {
        widths.push(80)
        return 80
      },
    })
    resizing.running(0, 0)
    resizing.running(1, 0)
    expect(widths.length).toBeGreaterThanOrEqual(2)
  })
})
