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
