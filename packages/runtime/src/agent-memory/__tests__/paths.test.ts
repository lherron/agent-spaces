/**
 * Red/green ownership for wrkq T-01482.
 *
 * Defines the Phase B path contract for the agent-memory engine, including the
 * persona target at per-agent SOUL.md and temp-root-only resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
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
  MEMORY_FILE: string
  USER_FILE: string
  PERSONA_FILE: string
  resolveMemoryPaths: (
    agentName: string,
    rootOverride?: string
  ) => Record<MemoryTargetName, MemoryTargetConfig>
}

describe('agent-memory path resolution', () => {
  let tempAgentsRoot: string

  beforeEach(async () => {
    tempAgentsRoot = await mkdtemp(join(process.cwd(), '.tmp-agent-memory-paths-'))
  })

  afterEach(async () => {
    await rm(tempAgentsRoot, { recursive: true, force: true })
  })

  test('exports stable filename constants including persona SOUL.md', async () => {
    const paths = await loadPathsModule()

    expect(paths.MEMORY_FILE).toBe('MEMORY.md')
    expect(paths.USER_FILE).toBe('USER.md')
    expect(paths.PERSONA_FILE).toBe('SOUL.md')
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

  test('keeps USER.md shared while MEMORY.md and SOUL.md are per-agent', async () => {
    const { resolveMemoryPaths } = await loadPathsModule()

    const smokey = resolveMemoryPaths('smokey', tempAgentsRoot)
    const clod = resolveMemoryPaths('clod', tempAgentsRoot)

    expect(smokey.user.path).toBe(clod.user.path)
    expect(smokey.memory.path).not.toBe(clod.memory.path)
    expect(smokey.persona.path).not.toBe(clod.persona.path)
    expect(smokey.persona.path).not.toContain('/memory/')
  })
})

async function loadPathsModule(): Promise<PathsModule> {
  try {
    return (await import('../paths.js')) as PathsModule
  } catch {
    throw new Error(
      'Expected packages/runtime/src/agent-memory/paths.ts to export MEMORY_FILE, USER_FILE, PERSONA_FILE, and resolveMemoryPaths().'
    )
  }
}
