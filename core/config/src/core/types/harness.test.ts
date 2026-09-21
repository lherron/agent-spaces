import { describe, expect, test } from 'bun:test'

import { DEFAULT_HARNESS, HARNESS_IDS, LOCK_HARNESSES, isHarnessId } from './harness.js'

describe('harness identification (T-08701)', () => {
  test('exposes exactly the four canonical public harness ids', () => {
    expect([...HARNESS_IDS]).toEqual(['agent-harness', 'claude', 'codex', 'muse'])
  })

  test('accepts canonical ids and rejects aliases, removed ids, and frontends', () => {
    for (const id of ['agent-harness', 'claude', 'codex', 'muse']) {
      expect(isHarnessId(id)).toBe(true)
    }
    for (const removed of [
      'claude-code',
      'codex-cli',
      'agent-sdk',
      'claude-agent-sdk',
      'pi',
      'pi-cli',
      'pi-sdk',
      'muse-cli',
      'agent-harness-tui',
      'viewer',
      '',
    ]) {
      expect(isHarnessId(removed)).toBe(false)
    }
  })

  test('defaults to agent-harness without owning provider/model routing', () => {
    expect(DEFAULT_HARNESS).toBe('agent-harness')
    expect(isHarnessId(DEFAULT_HARNESS)).toBe(true)
    expect([...LOCK_HARNESSES]).toEqual([DEFAULT_HARNESS])
  })
})
