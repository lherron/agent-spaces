import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveAgentSessionPath } from './session-manager.js'

describe('agent-harness session isolation', () => {
  test('does not permit explicit resume paths outside the selected agent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-harness-session-'))
    try {
      const sessionDir = join(root, 'cody')
      const otherDir = join(root, 'other-agent')
      await mkdir(sessionDir)
      await mkdir(otherDir)
      const own = join(sessionDir, 'own.jsonl')
      const other = join(otherDir, 'other.jsonl')
      await writeFile(own, '')
      await writeFile(other, '')

      expect(resolveAgentSessionPath(sessionDir, 'own.jsonl')).toBe(await realpath(own))
      expect(() => resolveAgentSessionPath(sessionDir, other)).toThrow(
        'outside the selected agent session directory'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
