import { describe, expect, test } from 'bun:test'
import { timestampVersion } from './publish-local-verdaccio'

describe('publish-local-verdaccio channel versions', () => {
  const now = new Date('2026-07-06T22:13:14Z')

  test('keeps the default dev channel shape unchanged', () => {
    expect(timestampVersion('0.1.1', 'dev', now, 'abc123')).toBe('0.1.1-dev.20260706221314')
  })

  test('uses a distinct worktree prerelease channel with the source short sha', () => {
    const version = timestampVersion('0.1.1', 'worktree', now, 'abc123def456')
    expect(version).toBe('0.1.1-worktree.20260706221314.abc123def456')
    expect(version).not.toContain('-dev.')
  })
})
