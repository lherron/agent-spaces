/**
 * Red/green ownership for wrkq T-01482.
 *
 * Defines the Phase B path contract for the agent-memory engine, including the
 * persona target at per-agent SOUL.md and temp-root-only resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type MemoryTargetName = 'memory' | 'user' | 'persona'

interface MemoryTargetConfig {
  path: string
  lockPath: string
  capChars: number
  scope: 'per-agent' | 'shared-editable'
  zone: 'reminder' | 'prompt'
  scannerCategoriesToSkip: string[]
}

interface PathsModule {
  resolveMemoryPaths: (
    agentName: string,
    rootOverride?: string
  ) => Record<MemoryTargetName, MemoryTargetConfig>
}

describe('agent-memory path resolution', () => {
  let tempAgentsRoot: string

  beforeEach(async () => {
    tempAgentsRoot = await mkdtemp(join(tmpdir(), 'agent-memory-paths-'))
  })

  afterEach(async () => {
    await rm(tempAgentsRoot, { recursive: true, force: true })
  })

  test('resolves memory, user, and persona targets under a temp agents root', async () => {
    const { resolveMemoryPaths } = await loadPathsModule()

    const paths = resolveMemoryPaths('smokey', tempAgentsRoot)

    expect(Object.keys(paths).sort()).toEqual(['memory', 'persona', 'user'])
    expect(paths.memory).toEqual({
      path: join(tempAgentsRoot, 'smokey', 'memory', 'MEMORY.md'),
      lockPath: join(tempAgentsRoot, 'smokey', 'memory', 'MEMORY.md.lock'),
      capChars: 2200,
      scope: 'per-agent',
      zone: 'reminder',
      scannerCategoriesToSkip: [],
    })
    expect(paths.user).toEqual({
      path: join(tempAgentsRoot, 'USER.md'),
      lockPath: join(tempAgentsRoot, 'USER.md.lock'),
      capChars: 1375,
      scope: 'shared-editable',
      zone: 'reminder',
      scannerCategoriesToSkip: [],
    })
    expect(paths.persona).toEqual({
      path: join(tempAgentsRoot, 'smokey', 'SOUL.md'),
      lockPath: join(tempAgentsRoot, 'smokey', 'SOUL.md.lock'),
      capChars: 8192,
      scope: 'per-agent',
      zone: 'prompt',
      scannerCategoriesToSkip: ['prompt_injection'],
    })
  })
})

async function loadPathsModule(): Promise<PathsModule> {
  try {
    return (await import('../paths.js')) as PathsModule
  } catch {
    throw new Error(
      'Expected core/runtime/src/agent-memory/paths.ts to export resolveMemoryPaths().'
    )
  }
}
