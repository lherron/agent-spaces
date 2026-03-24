/**
 * Tests for run helpers.
 *
 * WHY: Ensures the public helpers have basic coverage so bun test succeeds
 * and verifies core reference parsing behavior relied on by CLI callers.
 */

import { describe, expect, test } from 'bun:test'
import { ensureCodexProjectTrust, isSpaceReference } from './run.js'

describe('isSpaceReference', () => {
  test('returns true for valid space refs', () => {
    expect(isSpaceReference('space:base@dev')).toBe(true)
  })

  test('returns false for non-space strings', () => {
    expect(isSpaceReference('not-a-space-ref')).toBe(false)
  })
})

describe('ensureCodexProjectTrust', () => {
  test('appends a trusted project entry when one is missing', () => {
    const config = 'model = "gpt-5.3-codex"\n'
    const updated = ensureCodexProjectTrust(config, '/tmp/project')

    expect(updated).toContain('[projects."/tmp/project"]')
    expect(updated).toContain('trust_level = "trusted"')
  })

  test('does not duplicate an existing project trust entry', () => {
    const config = [
      'model = "gpt-5.3-codex"',
      '',
      '[projects."/tmp/project"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')

    const updated = ensureCodexProjectTrust(config, '/tmp/project')
    expect(updated).toBe(config)
  })
})
