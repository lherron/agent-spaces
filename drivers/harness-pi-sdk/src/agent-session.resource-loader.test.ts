import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SettingsManager } from '@earendil-works/pi-coding-agent'

import { createPiAgentResourceLoader } from './agent-session/index.js'

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const skillDir = join(root, name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8'
  )
}

describe('createPiAgentResourceLoader', () => {
  test('reloads the declared composed root and preserves supplied root order for duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-agent-resource-loader-'))
    const localSkills = join(root, 'agent-local-skills')
    const composedSkills = join(root, 'composed-skills')
    const agentDir = join(root, 'agent')
    await writeSkill(localSkills, 'duplicate', 'agent-local wins')
    await writeSkill(composedSkills, 'duplicate', 'composed duplicate')
    await writeSkill(composedSkills, 'composed-only', 'from composed bundle')

    const loader = createPiAgentResourceLoader(
      {
        cwd: root,
        agentDir,
        model: { provider: 'openai-codex', modelId: 'unused' },
        auth: {
          authMode: 'api-key',
          authPath: join(agentDir, 'auth.json'),
          providerId: 'openai-codex',
        },
        environment: {},
        skillPaths: [localSkills, composedSkills],
      },
      SettingsManager.inMemory()
    )
    await loader.reload()

    const { skills } = loader.getSkills()
    expect(skills.map((skill) => skill.name)).toContain('composed-only')
    const duplicate = skills.find((skill) => skill.name === 'duplicate')
    expect(duplicate?.description).toBe('agent-local wins')
  })
})
