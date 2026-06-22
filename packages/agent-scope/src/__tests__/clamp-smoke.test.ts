/**
 * RED acceptance test for T-05074.
 *
 * The implementation must live in packages/agent-scope/src/clamp-smoke.ts
 * and export clampInt without touching the package barrel.
 */
import { describe, expect, test } from 'bun:test'

import { clampInt } from '../clamp-smoke'

describe('clampInt (T-05074)', () => {
  test('returns min when value is below min', () => {
    expect(clampInt(-4, 0, 10)).toBe(0)
  })

  test('returns max when value is above max', () => {
    expect(clampInt(42, 0, 10)).toBe(10)
  })

  test('returns value when value is within range', () => {
    expect(clampInt(6, 0, 10)).toBe(6)
  })

  test('keeps the lower boundary inclusive', () => {
    expect(clampInt(0, 0, 10)).toBe(0)
  })

  test('keeps the upper boundary inclusive', () => {
    expect(clampInt(10, 0, 10)).toBe(10)
  })
})
