/**
 * Tests for agent-local synthetic plugin materialization in install.ts.
 *
 * WHY: T-01067 requires agent-root skills/ and commands/ to be copied into
 * a synthetic plugin artifact, not hardlinked, so mutable local files do not
 * affect materialized bundles unexpectedly.
 */

import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { AgentLocalComponents } from '../core/types/agent-local.js'
import { PathResolver } from '../store/index.js'
import { materializeAgentLocalComponents } from './install.js'

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

async function createPaths(prefix: string): Promise<{ aspHome: string; paths: PathResolver }> {
  const aspHome = await createTempDir(prefix)
  return { aspHome, paths: new PathResolver({ aspHome }) }
}

async function createAgentLocalComponents(options: {
  name: string
  hasSkills?: boolean
  hasCommands?: boolean
}): Promise<AgentLocalComponents> {
  const agentRoot = await createTempDir(`agent-local-${options.name}-`)
  const skillsDir = join(agentRoot, 'skills')
  const commandsDir = join(agentRoot, 'commands')

  if (options.hasSkills) {
    await mkdir(join(skillsDir, 'review-code'), { recursive: true })
    await writeFile(join(skillsDir, 'review-code', 'SKILL.md'), '# review\n')
  }

  if (options.hasCommands) {
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'deploy.md'), '# deploy\n')
  }

  return {
    agentRoot,
    hasSkills: options.hasSkills ?? false,
    hasCommands: options.hasCommands ?? false,
    skillsDir,
    commandsDir,
  }
}

describe('materializeAgentLocalComponents (T-01067)', () => {
  test('returns undefined when input is undefined', async () => {
    const { paths } = await createPaths('install-agent-local-none-')

    await expect(
      materializeAgentLocalComponents(undefined as unknown as AgentLocalComponents, paths)
    ).resolves.toBeUndefined()
  })

  test('materializes a skills-only synthetic plugin', async () => {
    const { paths } = await createPaths('install-agent-local-skills-')
    const components = await createAgentLocalComponents({ name: 'skills', hasSkills: true })

    const artifact = await materializeAgentLocalComponents(components, paths)

    expect(artifact).toBeDefined()
    expect(artifact?.pluginName).toBe(`${basename(components.agentRoot)}-agent`)
    expect(
      await readFile(join(artifact!.artifactPath, 'skills', 'review-code', 'SKILL.md'), 'utf-8')
    ).toBe('# review\n')
    await expect(stat(join(artifact!.artifactPath, 'commands'))).rejects.toThrow()
  })

  test('materializes a commands-only synthetic plugin', async () => {
    const { paths } = await createPaths('install-agent-local-commands-')
    const components = await createAgentLocalComponents({ name: 'commands', hasCommands: true })

    const artifact = await materializeAgentLocalComponents(components, paths)

    expect(artifact).toBeDefined()
    expect(await readFile(join(artifact!.artifactPath, 'commands', 'deploy.md'), 'utf-8')).toBe(
      '# deploy\n'
    )
    await expect(stat(join(artifact!.artifactPath, 'skills'))).rejects.toThrow()
  })

  test('materializes both skills and commands into the synthetic plugin', async () => {
    const { paths } = await createPaths('install-agent-local-both-')
    const components = await createAgentLocalComponents({
      name: 'both',
      hasSkills: true,
      hasCommands: true,
    })

    const artifact = await materializeAgentLocalComponents(components, paths)

    expect(
      await readFile(join(artifact!.artifactPath, 'skills', 'review-code', 'SKILL.md'), 'utf-8')
    ).toBe('# review\n')
    expect(await readFile(join(artifact!.artifactPath, 'commands', 'deploy.md'), 'utf-8')).toBe(
      '# deploy\n'
    )
  })

  test('writes plugin.json with <basename>-agent naming', async () => {
    const { paths } = await createPaths('install-agent-local-plugin-json-')
    const components = await createAgentLocalComponents({ name: 'plugin-json', hasSkills: true })

    const artifact = await materializeAgentLocalComponents(components, paths)
    const pluginJson = JSON.parse(
      await readFile(join(artifact!.artifactPath, '.claude-plugin', 'plugin.json'), 'utf-8')
    ) as { name: string; version: string; description: string }

    expect(pluginJson).toEqual({
      name: `${basename(components.agentRoot)}-agent`,
      version: '0.0.0',
      description: 'Agent-local skills and commands',
    })
  })

  test('uses copies instead of hardlinks for mutable agent-local files', async () => {
    const { paths } = await createPaths('install-agent-local-force-copy-')
    const components = await createAgentLocalComponents({
      name: 'force-copy',
      hasSkills: true,
      hasCommands: true,
    })

    const artifact = await materializeAgentLocalComponents(components, paths)
    const sourceSkill = await stat(join(components.skillsDir, 'review-code', 'SKILL.md'))
    const copiedSkill = await stat(
      join(artifact!.artifactPath, 'skills', 'review-code', 'SKILL.md')
    )

    expect(sourceSkill.ino).not.toBe(copiedSkill.ino)

    const artifactDirStats = await lstat(artifact!.artifactPath)
    expect(artifactDirStats.isDirectory()).toBe(true)
  })
})
