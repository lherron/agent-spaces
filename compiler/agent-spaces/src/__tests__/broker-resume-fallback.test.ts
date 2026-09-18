import { describe, expect, test } from 'bun:test'

import { brokerResumeFallback } from '../compile-runtime-plan'

describe('brokerResumeFallback', () => {
  test('muse-serve births start fresh on a stale continuation', () => {
    expect(brokerResumeFallback(true)).toBe('start-fresh')
  })

  test('codex births stay fail-fast on a stale continuation', () => {
    expect(brokerResumeFallback(false)).toBe('fail')
  })
})
