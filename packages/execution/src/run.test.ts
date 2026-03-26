/**
 * Tests for run helpers.
 *
 * WHY: Ensures the public helpers have basic coverage so bun test succeeds
 * and verifies core reference parsing behavior relied on by CLI callers.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import {
  ensureCodexProjectTrust,
  getProjectCodexRuntimeHomePath,
  isSpaceReference,
  migrateLegacyProjectCodexRuntimeHome,
  prepareCodexRuntimeHome,
} from './run.js'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

describe('isSpaceReference', () => {
  test('returns true for valid space refs', () => {
    expect(isSpaceReference('space:base@dev')).toBe(true)
  })

  test('returns false for non-space strings', () => {
    expect(isSpaceReference('not-a-space-ref')).toBe(false)
  })
})

describe('ensureCodexProjectTrust', () => {
  test('appends a trusted project entry when one is missing', () => {
    const config = 'model = "gpt-5.3-codex"\n'
    const updated = ensureCodexProjectTrust(config, '/tmp/project')

    expect(updated).toContain('[projects."/tmp/project"]')
    expect(updated).toContain('trust_level = "trusted"')
  })

  test('does not duplicate an existing project trust entry', () => {
    const config = [
      'model = "gpt-5.3-codex"',
      '',
      '[projects."/tmp/project"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')

    const updated = ensureCodexProjectTrust(config, '/tmp/project')
    expect(updated).toBe(config)
  })
})

describe('getProjectCodexRuntimeHomePath', () => {
  test('builds a readable runtime path from project basename and target name', () => {
    const runtimeHome = getProjectCodexRuntimeHomePath(
      '/tmp/asp-home',
      '/Users/example/Control Plane',
      'Code Review'
    )

    expect(runtimeHome).toBe('/tmp/asp-home/codex-homes/control-plane_code-review')
  })
})

describe('migrateLegacyProjectCodexRuntimeHome', () => {
  test('moves a legacy asp_modules runtime into ASP_HOME', async () => {
    const root = await createTempDir('run-migrate-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'project')
    const legacyRuntime = join(projectPath, 'asp_modules', 'animata', 'codex', 'codex.runtime')
    await mkdir(join(legacyRuntime, 'sessions'), { recursive: true })
    await writeFile(join(legacyRuntime, 'sessions', 'session.jsonl'), 'session-data\n')

    const runtimeHome = await migrateLegacyProjectCodexRuntimeHome(aspHome, projectPath, 'animata')

    expect(runtimeHome).toBe(join(aspHome, 'codex-homes', 'project_animata'))
    expect(await readFile(join(runtimeHome, 'sessions', 'session.jsonl'), 'utf-8')).toBe(
      'session-data\n'
    )
    await expect(stat(legacyRuntime)).rejects.toThrow()
  })
})

describe('prepareCodexRuntimeHome', () => {
  test('refreshes managed files into the persistent project runtime and preserves Codex state', async () => {
    const root = await createTempDir('run-runtime-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'control-plane')
    const bundleRoot = join(projectPath, 'asp_modules', 'codex', 'codex')
    const templateHome = join(bundleRoot, 'codex.home')
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'codex')

    await mkdir(join(templateHome, 'skills', 'fresh-skill'), { recursive: true })
    await mkdir(join(templateHome, 'prompts'), { recursive: true })
    await writeFile(join(templateHome, 'AGENTS.md'), 'fresh agents\n')
    await writeFile(join(templateHome, 'config.toml'), 'model = "gpt-5.4"\n')
    await writeFile(join(templateHome, 'manifest.json'), '{"name":"codex"}\n')
    await writeFile(join(templateHome, 'skills', 'fresh-skill', 'SKILL.md'), 'fresh skill\n')
    await writeFile(join(templateHome, 'prompts', 'review.md'), 'fresh prompt\n')

    await mkdir(join(runtimeHome, 'skills', 'stale-skill'), { recursive: true })
    await mkdir(join(runtimeHome, 'sessions'), { recursive: true })
    await writeFile(join(runtimeHome, 'skills', 'stale-skill', 'SKILL.md'), 'stale skill\n')
    await writeFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'session state\n')

    const resolvedRuntime = await prepareCodexRuntimeHome(
      {
        harnessId: 'codex',
        targetName: 'codex',
        rootDir: bundleRoot,
        pluginDirs: [templateHome],
        codex: {
          homeTemplatePath: templateHome,
          configPath: join(templateHome, 'config.toml'),
          agentsPath: join(templateHome, 'AGENTS.md'),
          skillsDir: join(templateHome, 'skills'),
          promptsDir: join(templateHome, 'prompts'),
        },
      },
      {
        aspHome,
        projectPath,
      }
    )

    expect(resolvedRuntime).toBe(runtimeHome)
    expect(await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')).toBe('fresh agents\n')
    expect(await readFile(join(runtimeHome, 'skills', 'fresh-skill', 'SKILL.md'), 'utf-8')).toBe(
      'fresh skill\n'
    )
    expect(await readFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'utf-8')).toBe(
      'session state\n'
    )
    await expect(stat(join(runtimeHome, 'skills', 'stale-skill'))).rejects.toThrow()

    const config = await readFile(join(runtimeHome, 'config.toml'), 'utf-8')
    expect(config).toContain('model = "gpt-5.4"')
    expect(config).toContain(`[projects.${JSON.stringify(projectPath)}]`)

    const metadata = JSON.parse(
      await readFile(join(runtimeHome, '.asp-runtime.json'), 'utf-8')
    ) as { mode: string; targetName: string; projectPath: string }
    expect(metadata.mode).toBe('project')
    expect(metadata.targetName).toBe('codex')
    expect(metadata.projectPath).toBe(projectPath)
  })
})
