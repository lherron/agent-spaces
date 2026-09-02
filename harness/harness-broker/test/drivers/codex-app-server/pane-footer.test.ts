import { describe, expect, test } from 'bun:test'
import { createStatusLine } from '../../../src/drivers/codex-app-server/status-line'

const ESC = String.fromCharCode(0x1b)
const CSI_PATTERN = new RegExp(`^${ESC}\\[([0-9;?]*)([A-Za-z])`)

/**
 * A terminal, in about forty lines. T-07906 turned the one-row status line into a
 * block of N, and at N > 1 the correctness of the whole thing is CURSOR ARITHMETIC
 * — an erase that walks down the wrong number of rows, or a paint that walks back
 * up the wrong number, lands on committed transcript and eats it.
 *
 * Asserting the byte stream would only re-state the implementation. So the stream
 * is replayed through a model of what a terminal does with it, and the assertions
 * are made against the CELLS: what the operator is left looking at. The canvas is
 * unbounded (no scroll region), which is the honest model for a pane whose footer
 * is always the bottom-most thing written.
 */
function terminal(): {
  write: (chunk: string) => void
  screen: () => string[]
} {
  const rows: string[] = ['']
  let row = 0
  let column = 0

  const ensure = (index: number): void => {
    while (rows.length <= index) rows.push('')
  }
  const put = (text: string): void => {
    ensure(row)
    const current = rows[row] ?? ''
    const padded = current.length < column ? current.padEnd(column, ' ') : current
    rows[row] = padded.slice(0, column) + text + padded.slice(column + text.length)
    column += text.length
  }

  return {
    write(chunk: string): void {
      let rest = chunk
      while (rest.length > 0) {
        const char = rest[0] as string
        if (char === '\r') {
          column = 0
          rest = rest.slice(1)
          continue
        }
        if (char === '\n') {
          row += 1
          column = 0
          ensure(row)
          rest = rest.slice(1)
          continue
        }
        if (char === ESC) {
          const match = CSI_PATTERN.exec(rest)
          if (match === null) {
            rest = rest.slice(1)
            continue
          }
          const [sequence, rawParam, verb] = match as unknown as [string, string, string]
          const count = rawParam.length > 0 ? Number(rawParam) : 1
          if (verb === 'K') {
            ensure(row)
            rows[row] = (rows[row] ?? '').slice(0, column)
          } else if (verb === 'A') {
            row = Math.max(0, row - count)
          } else if (verb === 'B') {
            row += count
            ensure(row)
          }
          // SGR ('m') and cursor visibility ('?25l'/'h') occupy no cell.
          rest = rest.slice(sequence.length)
          continue
        }
        const next = rest.search(new RegExp(`[\\r\\n${ESC}]`))
        const run = next === -1 ? rest : rest.slice(0, next)
        put(run)
        rest = rest.slice(run.length)
      }
    },
    screen: () => rows.map((text) => text.trimEnd()),
  }
}

function harness(drawerRows: () => string[]): {
  status: ReturnType<typeof createStatusLine>
  screen: () => string[]
  tick: (times?: number) => void
} {
  const pane = terminal()
  let ticker: (() => void) | undefined
  const status = createStatusLine({
    write: pane.write,
    renderRow: (frame) => `<running ${frame}>`,
    renderDrawer: drawerRows,
    now: () => 1_000,
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
    screen: pane.screen,
    tick: (times = 1) => {
      for (let i = 0; i < times; i += 1) ticker?.()
    },
  }
}

describe('the ephemeral footer keeps N rows out of scrollback (T-07906)', () => {
  test('a multi-row footer never survives a committed line', () => {
    let waiting = ['<drawer head>', '<drawer #7>', '<drawer #8>']
    const h = harness(() => waiting)

    h.status.observe({ type: 'turn.started' })
    h.status.writeLine('first transcript line')
    h.status.writeLine('second transcript line')
    waiting = ['<drawer head>', '<drawer #8>']
    h.status.refresh()
    h.status.writeLine('third transcript line')
    waiting = []
    h.status.observe({ type: 'turn.completed' })

    // Every footer row is gone; the transcript is intact and in order.
    expect(h.screen().filter((row) => row.length > 0)).toEqual([
      'first transcript line',
      'second transcript line',
      'third transcript line',
    ])
  })

  test('a shrinking footer leaves no orphaned rows behind', () => {
    let waiting = ['<a>', '<b>', '<c>', '<d>']
    const h = harness(() => waiting)
    h.status.observe({ type: 'turn.started' })
    waiting = ['<a>']
    h.status.refresh()

    const visible = h.screen().filter((row) => row.length > 0)
    expect(visible).toEqual(['<running 0>', '<a>'])
  })

  test('the footer repaints below the line it just committed, not over it', () => {
    const h = harness(() => ['<drawer head>', '<drawer #7>'])
    h.status.observe({ type: 'turn.started' })
    h.status.writeLine('committed')

    expect(h.screen().filter((row) => row.length > 0)).toEqual([
      'committed',
      '<running 0>',
      '<drawer head>',
      '<drawer #7>',
    ])
  })

  test('a drawer keeps the footer up after the turn ends, and ticks on its own', () => {
    let waiting = ['<drawer head>', '<drawer #7>']
    const h = harness(() => waiting)
    h.status.observe({ type: 'turn.started' })
    h.status.observe({ type: 'turn.completed' })

    // The running row is gone; the drawer is not, because the wait is not over.
    expect(h.screen().filter((row) => row.length > 0)).toEqual(['<drawer head>', '<drawer #7>'])

    // An idle drawer still repaints, so an age on a row is not frozen.
    h.tick(2)
    expect(h.screen().filter((row) => row.length > 0)).toEqual(['<drawer head>', '<drawer #7>'])

    waiting = []
    h.status.refresh()
    expect(h.screen().filter((row) => row.length > 0)).toEqual([])
  })

  test('the footer is capped so it can never grow taller than the pane', () => {
    const pane = terminal()
    const status = createStatusLine({
      write: pane.write,
      renderRow: (frame) => `<running ${frame}>`,
      renderDrawer: () => ['<a>', '<b>', '<c>', '<d>', '<e>'],
      maxHeight: () => 3,
      now: () => 0,
      schedule: () => 1,
      clearScheduled: () => {},
    })
    status.observe({ type: 'turn.started' })
    expect(pane.screen().filter((row) => row.length > 0)).toEqual(['<running 0>', '<a>', '<b>'])
  })

  test('a stall annotates the running row and any later event clears it', () => {
    const notes: (string | undefined)[] = []
    const status = createStatusLine({
      write: () => {},
      renderRow: (_frame, _elapsed, note) => {
        notes.push(note)
        return '<row>'
      },
      now: () => 0,
      schedule: () => 1,
      clearScheduled: () => {},
    })
    status.observe({ type: 'turn.started' })
    status.observe({ type: 'turn.stalled', payload: { noProgressMs: 45_000 } })
    status.observe({ type: 'tool.call.started' })

    expect(notes).toEqual([undefined, '45s', undefined])
  })
})
