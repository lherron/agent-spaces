/**
 * Tests for agent-local discovery validation in materialize-refs.
 *
 * WHY: T-01067 adds agent-local skills/commands that are merged with
 * space-provided plugins at materialization time. Conflicts must fail fast,
 * and the thread-through contract into materializeTarget must remain intact.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { detectCommandConflicts, discoverSkills } from './materialize-refs.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('discoverSkills (T-01067)', () => {
  test('throws when the same skill name exists in two different plugin dirs', async () => {
    const pluginA = await createTempDir('mat-refs-skill-a-')
    const pluginB = await createTempDir('mat-refs-skill-b-')

    await mkdir(join(pluginA, 'skills', 'review-code'), { recursive: true })
    await mkdir(join(pluginB, 'skills', 'review-code'), { recursive: true })
    await writeFile(join(pluginA, 'skills', 'review-code', 'SKILL.md'), '# review A\n')
    await writeFile(join(pluginB, 'skills', 'review-code', 'SKILL.md'), '# review B\n')

    await expect(discoverSkills([pluginA, pluginB])).rejects.toThrow('Skill name conflict')
  })

  test('returns skill metadata when names are unique across plugin dirs', async () => {
    const pluginA = await createTempDir('mat-refs-skill-unique-a-')
    const pluginB = await createTempDir('mat-refs-skill-unique-b-')

    await mkdir(join(pluginA, 'skills', 'review-code'), { recursive: true })
    await mkdir(join(pluginB, 'skills', 'triage'), { recursive: true })
    await writeFile(join(pluginA, 'skills', 'review-code', 'SKILL.md'), '# review\n')
    await writeFile(join(pluginB, 'skills', 'triage', 'SKILL.md'), '# triage\n')

    await expect(discoverSkills([pluginA, pluginB])).resolves.toEqual([
      {
        name: 'review-code',
        sourcePath: join(pluginA, 'skills', 'review-code', 'SKILL.md'),
        pluginDir: pluginA,
      },
      {
        name: 'triage',
        sourcePath: join(pluginB, 'skills', 'triage', 'SKILL.md'),
        pluginDir: pluginB,
      },
    ])
  })
})

describe('detectCommandConflicts (T-01067)', () => {
  test('throws when the same command name exists in two different plugin dirs', async () => {
    const pluginA = await createTempDir('mat-refs-command-a-')
    const pluginB = await createTempDir('mat-refs-command-b-')

    await mkdir(join(pluginA, 'commands'), { recursive: true })
    await mkdir(join(pluginB, 'commands'), { recursive: true })
    await writeFile(join(pluginA, 'commands', 'deploy.md'), '# deploy A\n')
    await writeFile(join(pluginB, 'commands', 'deploy.md'), '# deploy B\n')

    await expect(detectCommandConflicts([pluginA, pluginB])).rejects.toThrow(
      'Command name conflict'
    )
  })

  test('does not throw when command names are unique across plugin dirs', async () => {
    const pluginA = await createTempDir('mat-refs-command-unique-a-')
    const pluginB = await createTempDir('mat-refs-command-unique-b-')

    await mkdir(join(pluginA, 'commands'), { recursive: true })
    await mkdir(join(pluginB, 'commands'), { recursive: true })
    await writeFile(join(pluginA, 'commands', 'deploy.md'), '# deploy\n')
    await writeFile(join(pluginB, 'commands', 'build.md'), '# build\n')

    await expect(detectCommandConflicts([pluginA, pluginB])).resolves.toBeUndefined()
  })
})

describe('materializeFromRefs threading (T-01067)', () => {
  test('threads agentLocalComponents through to materializeTarget and keeps backward compatibility', async () => {
    const source = await readFile(join(import.meta.dir, 'materialize-refs.ts'), 'utf-8')

    expect(source).toContain('agentLocalComponents?: AgentLocalComponents | undefined')
    expect(source).toContain(
      '...(options.agentLocalComponents ? { agentLocalComponents: options.agentLocalComponents } : {})'
    )
  })
})
