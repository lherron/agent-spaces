import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncAgentToCodexDefault } from './sync-agent-to-codex-default'

const originalAspHome = process.env['ASP_HOME']

afterEach(() => {
  if (originalAspHome === undefined) {
    process.env['ASP_HOME'] = undefined
  } else {
    process.env['ASP_HOME'] = originalAspHome
  }
})

describe('syncAgentToCodexDefault', () => {
  test('resolves profile @dev spaces from the shared agents source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-default-sync-'))
    const aspHome = join(root, 'asp-home')
    const agentsRoot = join(root, 'agents')
    const agentRoot = join(agentsRoot, 'cody')
    const sharedSpace = join(agentsRoot, 'spaces', 'console-defaults')
    const codexHome = join(root, 'codex-home')
    const projectRoot = join(root, 'project')

    try {
      await mkdir(join(sharedSpace, 'skills', 'console-helper'), { recursive: true })
      await mkdir(agentRoot, { recursive: true })
      await mkdir(projectRoot, { recursive: true })
      await writeFile(join(agentRoot, 'SOUL.md'), '# Cody\n')
      await writeFile(
        join(agentRoot, 'agent-profile.toml'),
        ['version = 3', '', '[spaces]', 'base = ["space:console-defaults@dev"]', ''].join('\n')
      )
      await writeFile(
        join(sharedSpace, 'space.toml'),
        [
          'schema = 1',
          'id = "console-defaults"',
          'version = "0.1.0"',
          'description = "Console-only capabilities"',
          '',
          '[plugin]',
          'name = "console-defaults"',
          '',
        ].join('\n')
      )
      await writeFile(
        join(sharedSpace, 'skills', 'console-helper', 'SKILL.md'),
        '# Console helper\n'
      )

      const result = await syncAgentToCodexDefault({
        agentId: 'cody',
        codexHome,
        aspHome,
        agentsRoot,
        projectRoot,
        apply: false,
        fetchRegistry: false,
        installHooks: false,
      })

      expect(result.plan.refs).toEqual(['space:console-defaults@dev'])
      expect(result.plan.skills).toContainEqual(
        expect.objectContaining({ name: 'console-helper', action: 'copy' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('syncAgentToCodexDefault retires a previous agent from the Codex home', () => {
  test('plans and applies removal of the previous agent block, clean skills, and manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-default-retire-'))
    const aspHome = join(root, 'asp-home')
    const agentsRoot = join(root, 'agents')
    const agentRoot = join(agentsRoot, 'stella')
    const sharedSpace = join(agentsRoot, 'spaces', 'console-defaults')
    const codexHome = join(root, 'codex-home')
    const projectRoot = join(root, 'project')

    const marker = (agentId: string, skillName: string, contentHash?: string) =>
      JSON.stringify({
        schemaVersion: 1,
        owner: 'agent-spaces',
        agentId,
        kind: 'codex-skill',
        skillName,
        ...(contentHash ? { contentHash } : {}),
      })

    try {
      await mkdir(join(sharedSpace, 'skills', 'console-helper'), { recursive: true })
      await mkdir(agentRoot, { recursive: true })
      await mkdir(projectRoot, { recursive: true })
      await writeFile(join(agentRoot, 'SOUL.md'), '# Stella\n')
      await writeFile(
        join(agentRoot, 'agent-profile.toml'),
        ['version = 3', '', '[spaces]', 'base = ["space:console-defaults@dev"]', ''].join('\n')
      )
      await writeFile(
        join(sharedSpace, 'space.toml'),
        [
          'schema = 1',
          'id = "console-defaults"',
          'version = "0.1.0"',
          'description = "Console-only capabilities"',
          '',
          '[plugin]',
          'name = "console-defaults"',
          '',
        ].join('\n')
      )
      await writeFile(
        join(sharedSpace, 'skills', 'console-helper', 'SKILL.md'),
        '# Console helper\n'
      )

      // Previous tenant: cody. One skill also in the new source, one only cody had,
      // one cody skill with local edits (dirty), plus its AGENTS.md block and manifest.
      await mkdir(join(codexHome, '.asp-agent-sync'), { recursive: true })
      await writeFile(
        join(codexHome, 'AGENTS.md'),
        [
          '# User notes',
          '',
          '<!-- BEGIN agent-spaces:codex-default agent=cody -->',
          'cody block',
          '<!-- END agent-spaces:codex-default agent=cody -->',
          '',
        ].join('\n')
      )
      await writeFile(
        join(codexHome, '.asp-agent-sync', 'cody.json'),
        JSON.stringify({ schemaVersion: 1, owner: 'agent-spaces', agentId: 'cody' })
      )
      for (const name of ['console-helper', 'cody-only', 'cody-dirty']) {
        await mkdir(join(codexHome, 'skills', name), { recursive: true })
        await writeFile(join(codexHome, 'skills', name, 'SKILL.md'), `# ${name}\n`)
      }
      await writeFile(
        join(codexHome, 'skills', 'console-helper', '.asp-agent-sync.json'),
        marker('cody', 'console-helper')
      )
      await writeFile(
        join(codexHome, 'skills', 'cody-only', '.asp-agent-sync.json'),
        marker('cody', 'cody-only')
      )
      await writeFile(
        join(codexHome, 'skills', 'cody-dirty', '.asp-agent-sync.json'),
        marker('cody', 'cody-dirty', 'sha256-of-something-else')
      )
      await mkdir(join(codexHome, 'skills', 'user-own'), { recursive: true })
      await writeFile(join(codexHome, 'skills', 'user-own', 'SKILL.md'), '# mine\n')

      const dry = await syncAgentToCodexDefault({
        agentId: 'stella',
        codexHome,
        aspHome,
        agentsRoot,
        projectRoot,
        apply: false,
        fetchRegistry: false,
        installHooks: false,
      })
      expect(dry.plan.retire).toEqual({
        agents: ['cody'],
        skills: ['cody-only'],
        manifests: ['cody'],
      })
      expect(dry.plan.skills).toContainEqual(
        expect.objectContaining({ name: 'console-helper', action: 'copy', retiresAgent: 'cody' })
      )
      expect(dry.plan.warnings.join('\n')).toContain('cody-dirty')
      expect(existsSync(join(codexHome, 'skills', 'cody-only'))).toBe(true)

      const applied = await syncAgentToCodexDefault({
        agentId: 'stella',
        codexHome,
        aspHome,
        agentsRoot,
        projectRoot,
        apply: true,
        fetchRegistry: false,
        installHooks: false,
      })
      expect(applied.applied).toBe(true)
      const agents = await readFile(join(codexHome, 'AGENTS.md'), 'utf8')
      expect(agents).toContain('# User notes')
      expect(agents).toContain('<!-- BEGIN agent-spaces:codex-default agent=stella -->')
      expect(agents).not.toContain('agent=cody')
      expect(existsSync(join(codexHome, '.asp-agent-sync', 'cody.json'))).toBe(false)
      expect(existsSync(join(codexHome, '.asp-agent-sync', 'stella.json'))).toBe(true)
      expect(existsSync(join(codexHome, 'skills', 'cody-only'))).toBe(false)
      expect(existsSync(join(codexHome, 'skills', 'cody-dirty'))).toBe(true)
      expect(existsSync(join(codexHome, 'skills', 'user-own'))).toBe(true)
      const helperMarker = JSON.parse(
        await readFile(join(codexHome, 'skills', 'console-helper', '.asp-agent-sync.json'), 'utf8')
      ) as { agentId: string }
      expect(helperMarker.agentId).toBe('stella')

      // Second run is a no-op for retirement.
      const again = await syncAgentToCodexDefault({
        agentId: 'stella',
        codexHome,
        aspHome,
        agentsRoot,
        projectRoot,
        apply: false,
        fetchRegistry: false,
        installHooks: false,
      })
      expect(again.plan.retire).toEqual({ agents: [], skills: [], manifests: [] })
      expect(again.plan.agents.action).toBe('unchanged')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
