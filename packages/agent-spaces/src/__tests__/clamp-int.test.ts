import { describe, expect, it } from 'bun:test'

import { clampInt } from '../index'

// T-05110 acceptance bar: clampInt must be a pure public helper exported from agent-spaces.
describe('clampInt', () => {
  it('clamps values below and above the accepted range', () => {
    expect(clampInt(-3, 0, 10)).toBe(0)
    expect(clampInt(15, 0, 10)).toBe(10)
  })

  it('preserves in-range integer values and exact bounds', () => {
    expect(clampInt(7, 0, 10)).toBe(7)
    expect(clampInt(0, 0, 10)).toBe(0)
    expect(clampInt(10, 0, 10)).toBe(10)
  })

  it('truncates non-integer values toward zero before clamping', () => {
    expect(clampInt(4.9, 0, 10)).toBe(4)
    expect(clampInt(-4.9, -10, 10)).toBe(-4)
  })

  it('throws RangeError when min is greater than max', () => {
    expect(() => clampInt(5, 10, 0)).toThrow(RangeError)
  })
})
