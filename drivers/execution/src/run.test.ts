/**
 * Tests for run.ts: the run-owned helpers and the surface it re-exports.
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
import * as runModule from './run.js'

const createTempDir = useTempDirs()

describe('isSpaceReference', () => {
  test('returns true for valid space refs', () => {
    expect(isSpaceReference('space:base@dev')).toBe(true)
  })

  test('returns false for non-space strings', () => {
    expect(isSpaceReference('not-a-space-ref')).toBe(false)
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

describe('run.ts re-exported surface', () => {
  // Callers import these through run.ts (T-01067, T-00995, T-01097).
  for (const name of [
    'detectAgentLocalComponents',
    'resolveAgentRunDefaults',
    'planPlacementRuntime',
  ]) {
    test(`${name} is exported from run.ts`, () => {
      expect(typeof (runModule as Record<string, unknown>)[name]).toBe('function')
    })
  }
})

describe('system prompt threading (T-01016)', () => {
  test('RunResult exposes systemPromptMode, reminderContent, and maxChars', () => {
    // Structural gate: the RunResult type must keep these prompt-threading
    // fields. Removing one would fail this construction at typecheck time.
    const result: runModule.RunResult = {
      build: {
        pluginDirs: [],
        warnings: [],
        lock: {
          lockfileVersion: 1,
          resolverVersion: 1,
          generatedAt: '2026-01-01T00:00:00Z',
          registry: { type: 'git', url: 'local' },
          spaces: {},
          targets: {},
        },
      },
      exitCode: 0,
      systemPromptMode: 'append',
      reminderContent: 'reminder',
      maxChars: 8192,
    }
    expect(result.systemPromptMode).toBe('append')
    expect(result.reminderContent).toBe('reminder')
    expect(result.maxChars).toBe(8192)
  })
})
