/**
 * Tests for run.ts: the run-owned helpers.
 *
 * Collaborator modules are tested beside their sources (run-codex.test.ts,
 * run/agent-profile.test.ts, run/placement-plan.test.ts, run/util.test.ts).
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { getLegacyProjectHarnessOutputPath, getProjectHarnessOutputPath } from 'spaces-config'

import { useTempDirs } from '../test/temp-dirs.js'
import { isSpaceReference, migrateLegacyProjectHarnessOutput } from './run.js'

const createTempDir = useTempDirs()

describe('isSpaceReference', () => {
  test.each([
    ['space:base@dev', true],
    ['not-a-space-ref', false],
  ])('%s is treated as a space reference: %p', (value, expected) => {
    expect(isSpaceReference(value)).toBe(expected)
  })
})

describe('migrateLegacyProjectHarnessOutput', () => {
  test('moves old path-hashed project target bundles into the shared scope home', async () => {
    const root = await createTempDir('run-migrate-bundle-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'agent-spaces')
    const legacyOutput = getLegacyProjectHarnessOutputPath(projectPath, 'larry', 'codex', aspHome)
    const outputPath = getProjectHarnessOutputPath(projectPath, 'larry', 'codex', aspHome)

    await mkdir(legacyOutput, { recursive: true })
    await writeFile(join(legacyOutput, 'state.json'), 'legacy-state\n')

    await migrateLegacyProjectHarnessOutput(aspHome, projectPath, 'larry', 'codex', outputPath)

    expect(await readFile(join(outputPath, 'state.json'), 'utf-8')).toBe('legacy-state\n')
    await expect(stat(legacyOutput)).rejects.toThrow()
  })
})
