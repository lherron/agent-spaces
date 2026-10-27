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
import type { SpaceId, SpaceKey } from '../core/index.js'
import type { SpaceManifest } from '../core/index.js'
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
  it('lint aggregates every rule and orders findings by code', async () => {
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

    // SKILL.md without frontmatter (E208): its rule runs last, so only the sort puts it first.
    await mkdir(join(plugin1, 'skills', 'x'), { recursive: true })
    await writeFile(join(plugin1, 'skills', 'x', 'SKILL.md'), '# No frontmatter\n')

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
    expect(warnings.map((warning) => warning.code)).toEqual(['E208', 'W201', 'W205'])
  })
})
