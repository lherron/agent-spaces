/**
 * Tests for run helpers.
 *
 * WHY: Ensures the public helpers have basic coverage so bun test succeeds
 * and verifies core reference parsing behavior relied on by CLI callers.
 */

import { describe, expect, test } from 'bun:test'
import { isSpaceReference } from './run.js'

describe('isSpaceReference', () => {
  test('returns true for valid space refs', () => {
    expect(isSpaceReference('space:base@dev')).toBe(true)
  })

  test('returns false for non-space strings', () => {
    expect(isSpaceReference('not-a-space-ref')).toBe(false)
  })
})
