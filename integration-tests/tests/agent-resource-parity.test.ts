import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import type { Skill } from '@earendil-works/pi-coding-agent'

import { compareProjections } from '../lib/agent-resource-parity/compare.js'
import { projectResources } from '../lib/agent-resource-parity/projection.js'

async function fixtureSkill(root: string): Promise<Skill> {
  const skillDir = join(root, 'fixture')
  await mkdir(join(skillDir, 'nested'), { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: fixture\ndescription: fixture skill\n---\n# Fixture\n'
  )
  await writeFile(join(skillDir, 'nested', 'asset.txt'), 'raw asset\n')
  await chmod(join(skillDir, 'nested', 'asset.txt'), 0o755)
  await symlink('nested/asset.txt', join(skillDir, 'asset-link'))
  return {
    name: 'fixture',
    description: 'fixture skill',
    disableModelInvocation: false,
    filePath: join(skillDir, 'SKILL.md'),
    baseDir: skillDir,
    sourceInfo: { source: 'fixture' } as Skill['sourceInfo'],
  }
}

describe('agent resource parity task fixture', () => {
  test('compares raw prompt/reminder bytes and selected skill package metadata without absolute roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resource-parity-'))
    const skill = await fixtureSkill(root)
    const input = {
      agentId: 'fixture-agent',
      mode: 'task' as const,
      prompt: { mode: 'replace' as const, content: 'task=T-PARITY\n' },
      reminder: '',
      skills: [skill],
      skillRoots: [root],
    }
    const left = await projectResources(input)
    const right = await projectResources(input)

    expect(compareProjections(left, right)).toEqual([])
    expect(left.reminder.present).toBe(true)
    expect(left.skills.catalog[0]?.filePath).toBe('skill://fixture/SKILL.md')
    expect(left.skills.packages.get('fixture')).toContainEqual(
      expect.objectContaining({ path: 'asset-link', kind: 'symlink', target: 'nested/asset.txt' })
    )
    expect(left.skills.packages.get('fixture')).toContainEqual(
      expect.objectContaining({ path: 'nested/asset.txt', kind: 'file', executable: true })
    )
  })

  test('reports a bounded stable first-byte mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resource-parity-diff-'))
    const skill = await fixtureSkill(root)
    const base = {
      agentId: 'fixture-agent',
      mode: 'task' as const,
      reminder: undefined,
      skills: [skill],
      skillRoots: [root],
    }
    const left = await projectResources({ ...base, prompt: { mode: 'replace', content: 'left' } })
    const right = await projectResources({ ...base, prompt: { mode: 'replace', content: 'lift' } })
    expect(compareProjections(left, right)).toEqual([
      expect.objectContaining({
        path: 'prompt/content.bin',
        message: expect.stringContaining('bytes differ at 1'),
      }),
    ])
  })
})
