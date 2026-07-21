import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
        ['schemaVersion = 2', '', '[spaces]', 'base = ["space:console-defaults@dev"]', ''].join(
          '\n'
        )
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
