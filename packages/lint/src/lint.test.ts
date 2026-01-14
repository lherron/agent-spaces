/**
 * Tests for main lint function.
 *
 * WHY: The lint function orchestrates all rules.
 * These tests verify correct rule execution and result aggregation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpaceId, SpaceKey } from 'spaces-core'
import type { SpaceManifest } from 'spaces-core'
import { lint } from './index.js'
import type { LintContext, SpaceLintData } from './types.js'

let tempDir: string

function createManifest(overrides: Partial<SpaceManifest> = {}): SpaceManifest {
  return {
    schema: 1,
    id: 'test-space' as SpaceId,
    ...overrides,
  }
}

function createSpaceLintData(
  key: string,
  manifest: SpaceManifest,
  pluginPath: string
): SpaceLintData {
  return {
    key: key as SpaceKey,
    manifest,
    pluginPath,
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'lint-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('lint', () => {
  it('should return no warnings for clean context', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(plugin, { recursive: true })

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await lint(context)
    expect(warnings).toHaveLength(0)
  })

  it('should aggregate warnings from multiple rules', async () => {
    const plugin1 = join(tempDir, 'plugin1')
    const plugin2 = join(tempDir, 'plugin2')

    // Setup for command collision
    await mkdir(join(plugin1, 'commands'), { recursive: true })
    await mkdir(join(plugin2, 'commands'), { recursive: true })
    await writeFile(join(plugin1, 'commands', 'shared.md'), '# Cmd')
    await writeFile(join(plugin2, 'commands', 'shared.md'), '# Cmd')

    // Setup for invalid hooks
    await mkdir(join(plugin1, 'hooks'), { recursive: true })
    // No hooks.json - should trigger W204

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin1),
        createSpaceLintData('space2@def456', createManifest({ id: 'space2' as SpaceId }), plugin2),
      ],
    }

    const warnings = await lint(context)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('should sort warnings by code', async () => {
    const plugin1 = join(tempDir, 'plugin1')
    const plugin2 = join(tempDir, 'plugin2')

    // Setup for plugin name collision (W205)
    await mkdir(plugin1, { recursive: true })
    await mkdir(plugin2, { recursive: true })

    // Setup for command collision (W201)
    await mkdir(join(plugin1, 'commands'), { recursive: true })
    await mkdir(join(plugin2, 'commands'), { recursive: true })
    await writeFile(join(plugin1, 'commands', 'cmd.md'), '# Cmd')
    await writeFile(join(plugin2, 'commands', 'cmd.md'), '# Cmd')

    const context: LintContext = {
      spaces: [
        createSpaceLintData(
          'space1@abc123',
          createManifest({
            id: 'space1' as SpaceId,
            plugin: { name: 'same-name' },
          }),
          plugin1
        ),
        createSpaceLintData(
          'space2@def456',
          createManifest({
            id: 'space2' as SpaceId,
            plugin: { name: 'same-name' },
          }),
          plugin2
        ),
      ],
    }

    const warnings = await lint(context)
    expect(warnings.length).toBeGreaterThanOrEqual(2)

    // Check sorting
    for (let i = 1; i < warnings.length; i++) {
      const current = warnings[i]
      const previous = warnings[i - 1]
      if (current && previous) {
        expect(current.code >= previous.code).toBe(true)
      }
    }
  })
})
