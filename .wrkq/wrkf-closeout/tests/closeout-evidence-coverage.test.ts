import { describe, expect, test } from 'bun:test'
import config from '../closeout-config.json'
import { classifyChangedFiles } from '../scripts/closeout-evidence-coverage'
import type { Config } from '../scripts/closeout-evidence-coverage'

const closeoutConfig = config as Config

describe('closeout path classifier', () => {
  test('keeps docs-only changes at docs', () => {
    expect(classifyChangedFiles(['docs/closeout-evidence.md'], 'docs', closeoutConfig)).toBe('docs')
  })

  test('escalates harness paths above a docs claim', () => {
    expect(
      classifyChangedFiles(['packages/harness-broker/src/core.ts'], 'docs', closeoutConfig)
    ).toBe('harness')
  })

  test('uses claim surface as conservative floor for unmatched paths', () => {
    expect(classifyChangedFiles(['unmapped/private.file'], 'contract', closeoutConfig)).toBe(
      'contract'
    )
  })
})
