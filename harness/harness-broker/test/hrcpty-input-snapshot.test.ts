import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { selectAntigravityInput } from '../src/drivers/antigravity-cli-hrcpty/input-box'
import { type HrcptyCapture, inputSnapshotFrom } from '../src/runtime/hrcpty'

// A live max3 capture of an idle Antigravity seat whose last reply wrapped and
// whose banner scrolled off. hrc-pty's styled capture then holds more rows
// than the viewport, so the styled row at the plain cursor index is a line of
// the reply, not the prompt, and the box never read empty.
const capture = JSON.parse(
  readFileSync(
    join(import.meta.dir, 'fixtures/hrcpty/antigravity-wrapped-scrollback-capture.json'),
    'utf8'
  )
) as { plain: HrcptyCapture; styled: HrcptyCapture }

describe('hrcpty input snapshot', () => {
  test('pairs the styled row with the plain cursor row when the styled capture has extra rows', () => {
    const snapshot = inputSnapshotFrom(capture.plain, capture.styled)
    expect(snapshot.line.startsWith('> Auto mode:')).toBe(true)
    expect(snapshot.styledLine).toContain('Auto mode:')
    expect(selectAntigravityInput(snapshot).empty).toBe(true)
  })
})

// hrc-pty's opt-in row-aligned capture ({styled:true, rows:true}), recorded by
// hrc-runtime's acceptance run: one styled line per viewport row.
const rowsCapture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/hrcpty/styled-rows-capture.json'), 'utf8')
) as { plain: HrcptyCapture; styled: HrcptyCapture }

describe('hrcpty input snapshot, row-aligned styled capture', () => {
  test('reads the styled row at the cursor index', () => {
    const { plain, styled } = rowsCapture
    const snapshot = inputSnapshotFrom(plain, styled)
    expect(snapshot.styledLine).toBe(styled.text.split('\n')[plain.cursor.y] as string)
    expect(snapshot.styledLine).toContain('\x1b[2mType a message')
  })

  test('trusts the index over a lower row with the same visible text', () => {
    // A styled row can differ in visible text from its plain twin (a wide
    // cell's spacing); with a row contract the index is still the cursor row.
    const rows = Array.from({ length: 6 }, (_, i) => `row ${i}`)
    const plainRows = [...rows]
    plainRows[2] = '> draft'
    const styledRows = [...rows]
    styledRows[2] = '\x1b[1m>\x1b[0m  draft'
    styledRows[4] = '\x1b[2m> draft\x1b[0m'
    const snapshot = inputSnapshotFrom(
      { text: plainRows.join('\n'), cursor: { x: 2, y: 2 }, cols: 80, rows: 6 } as HrcptyCapture,
      {
        text: styledRows.join('\n'),
        cursor: { x: 2, y: 2 },
        cols: 80,
        rows: 6,
        layout: 'styled-rows',
      } as HrcptyCapture
    )
    expect(snapshot.styledLine).toBe(styledRows[2] as string)
  })
})
