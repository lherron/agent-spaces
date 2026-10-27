/**
 * Tests for claude detect module.
 *
 * Detection through the driver (PATH discovery, probe caching) is tested via
 * ClaudeAdapter.detect() in adapters/claude-adapter.test.ts. This file keeps the
 * candidate-order seam: common install paths are host-fixed, so only the
 * candidate list can show they precede PATH.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { CLAUDE_SKIP_COMMON_PATHS_ENV, claudeCommandCandidates } from './detect.js'

const originalPath = process.env['PATH']
const originalSkipCommonPaths = process.env[CLAUDE_SKIP_COMMON_PATHS_ENV]

afterEach(() => {
  process.env['PATH'] = originalPath
  if (originalSkipCommonPaths === undefined) {
    process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = undefined
  } else {
    process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = originalSkipCommonPaths
  }
})

describe('findClaudeBinary', () => {
  it('keeps common install paths ahead of PATH candidates', () => {
    process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] = undefined
    process.env['PATH'] = '/path-first:/path-second'

    const candidates = claudeCommandCandidates()

    expect(candidates[0]).toBe('/opt/homebrew/bin/claude')
    expect(candidates.indexOf('/usr/local/bin/claude')).toBeLessThan(
      candidates.indexOf('/path-first/claude')
    )
    expect(candidates.at(-1)).toBe('/path-second/claude')
  })
})
