import { describe, expect, test } from 'bun:test'

import { brokerResumeFallback } from '../broker-request-projection'

describe('brokerResumeFallback', () => {
  test.each([
    ['muse-serve births start fresh', true, 'start-fresh'],
    ['codex births stay fail-fast', false, 'fail'],
  ] as const)('%s on a stale continuation', (_name, startsFresh, expected) => {
    expect(brokerResumeFallback(startsFresh)).toBe(expected)
  })
})
