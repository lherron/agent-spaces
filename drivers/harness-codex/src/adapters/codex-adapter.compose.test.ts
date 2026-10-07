/**
 * CodexAdapter.composeTarget: materialized artifacts merge into a deterministic
 * codex.home template (config.toml, AGENTS.md, skills, prompts, mcp, hooks).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import TOML from '@iarna/toml'
import { codexArtifact, composeTargetInput } from '../test-support/codex-adapter-inputs.js'
import { CodexAdapter } from './codex-adapter.js'

describe('CodexAdapter', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
  })

  describe('composeTarget', () => {
    let tmpDir: string
    let outputDir: string
    let artifact1Dir: string
    let artifact2Dir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `codex-adapter-compose-${Date.now()}`)
      outputDir = join(tmpDir, 'output')
      artifact1Dir = join(tmpDir, 'artifact1')
      artifact2Dir = join(tmpDir, 'artifact2')

      await mkdir(outputDir, { recursive: true })
      await mkdir(artifact1Dir, { recursive: true })
      await mkdir(artifact2Dir, { recursive: true })

      await mkdir(join(artifact1Dir, 'skills', 'shared'), { recursive: true })
      await writeFile(join(artifact1Dir, 'skills', 'shared', 'SKILL.md'), 'one')
      await mkdir(join(artifact1Dir, 'prompts'), { recursive: true })
      await writeFile(join(artifact1Dir, 'prompts', 'hello.md'), 'first')
      await writeFile(join(artifact1Dir, 'instructions.md'), 'instructions one')
      await writeFile(
        join(artifact1Dir, 'codex.config.json'),
        JSON.stringify({ 'features.web_search_request': false })
      )
      await mkdir(join(artifact1Dir, 'mcp'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'mcp', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            serverA: { type: 'stdio', command: 'cmd-a' },
          },
        })
      )

      await mkdir(join(artifact2Dir, 'skills', 'shared'), { recursive: true })
      await mkdir(join(artifact2Dir, 'skills', 'extra'), { recursive: true })
      await writeFile(join(artifact2Dir, 'skills', 'shared', 'SKILL.md'), 'two')
      await writeFile(join(artifact2Dir, 'skills', 'extra', 'SKILL.md'), 'extra')
      await mkdir(join(artifact2Dir, 'prompts'), { recursive: true })
      await writeFile(join(artifact2Dir, 'prompts', 'hello.md'), 'second')
      await writeFile(join(artifact2Dir, 'prompts', 'second.md'), 'second prompt')
      await writeFile(join(artifact2Dir, 'instructions.md'), 'instructions two')
      await writeFile(
        join(artifact2Dir, 'codex.config.json'),
        JSON.stringify({
          approval_policy: 'never',
          model_reasoning_effort: 'low',
        })
      )
      await mkdir(join(artifact2Dir, 'mcp'), { recursive: true })
      await writeFile(
        join(artifact2Dir, 'mcp', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            serverA: { type: 'stdio', command: 'override' },
            serverB: { type: 'stdio', command: 'cmd-b' },
          },
        })
      )
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('renders nested space codex.config tables and never a profile key (T-08581)', async () => {
      await writeFile(
        join(artifact2Dir, 'codex.config.json'),
        JSON.stringify({
          model: 'muse-spark-1.3-contributor',
          model_providers: {
            meta: {
              name: 'Meta Model API',
              auth: { command: '/usr/bin/security', args: ['find-generic-password', '-w'] },
            },
          },
          apps: { connector_x: { enabled: false } },
        })
      )
      const input = composeTargetInput(
        'test-target',
        [codexArtifact('space2@def', artifact2Dir, '2.0.0')],
        { profile: 'meta' } as Record<string, unknown>
      )

      await adapter.composeTarget(input, outputDir, { clean: true })
      const raw = await readFile(join(outputDir, 'codex.home', 'config.toml'), 'utf-8')
      const config = TOML.parse(raw) as Record<string, any>
      expect(config['model']).toBe('muse-spark-1.3-contributor')
      expect(config['model_providers']['meta']['auth']).toEqual({
        command: '/usr/bin/security',
        args: ['find-generic-password', '-w'],
      })
      expect(config['apps']['connector_x']).toEqual({ enabled: false })
      expect(raw).toContain('[model_providers.meta]')
      expect(config['profile']).toBeUndefined()
    })

    test('composes codex.home with overrides and merged content', async () => {
      const input = composeTargetInput(
        'test-target',
        [
          codexArtifact('space1@abc', artifact1Dir, '1.0.0'),
          codexArtifact('space2@def', artifact2Dir, '2.0.0'),
        ],
        {
          model: 'gpt-5.3-codex',
          model_reasoning_effort: 'medium',
          model_reasoning_summary: 'none',
          status_line: ['model', 'context-remaining', 'git-branch'],
          approval_policy: 'on-request',
          sandbox_mode: 'danger-full-access',
        }
      )

      const result = await adapter.composeTarget(input, outputDir, { clean: true })
      const codexHome = join(outputDir, 'codex.home')

      expect(result.bundle.codex?.homeTemplatePath).toBe(codexHome)

      const mergedSkill = await readFile(join(codexHome, 'skills', 'shared', 'SKILL.md'), 'utf-8')
      expect(mergedSkill).toBe('two')

      const mergedPrompt = await readFile(join(codexHome, 'prompts', 'hello.md'), 'utf-8')
      expect(mergedPrompt).toBe('second')

      const agents = await readFile(join(codexHome, 'AGENTS.md'), 'utf-8')
      expect(agents).toContain('BEGIN space: space1@1.0.0')
      expect(agents).toContain('instructions one')
      expect(agents).toContain('BEGIN space: space2@2.0.0')
      expect(agents).toContain('instructions two')

      const configRaw = await readFile(join(codexHome, 'config.toml'), 'utf-8')
      const parsed = TOML.parse(configRaw) as Record<string, unknown>
      expect(parsed['approval_policy']).toBe('on-request')
      expect(parsed['sandbox_mode']).toBe('danger-full-access')
      expect(parsed['model']).toBe('gpt-5.3-codex')
      expect(parsed['model_reasoning_effort']).toBe('medium')
      expect(parsed['model_reasoning_summary']).toBe('none')
      expect((parsed['features'] as Record<string, unknown>)['hooks']).toBe(true)
      expect((parsed['tui'] as Record<string, unknown>)['status_line']).toEqual([
        'model',
        'context-remaining',
        'git-branch',
      ])
      const hookState = ((parsed['hooks'] as Record<string, unknown>)['state'] ?? {}) as Record<
        string,
        Record<string, unknown>
      >
      const hookKey = `${join(codexHome, 'hooks.json')}:stop:0:0`
      expect(Object.keys(hookState)).toContain(hookKey)
      expect(hookState[hookKey]?.['trusted_hash']).toMatch(/^sha256:[a-f0-9]{64}$/)

      const mcpServers = parsed['mcp_servers'] as Record<string, Record<string, unknown>>
      expect(mcpServers['serverA']?.['command']).toBe('override')
      expect(mcpServers['serverB']?.['command']).toBe('cmd-b')

      const hooksRaw = await readFile(join(codexHome, 'hooks.json'), 'utf-8')
      const hooks = JSON.parse(hooksRaw) as {
        hooks?: { Stop?: Array<{ hooks?: Array<Record<string, unknown>> }> }
      }
      const stopCommand = hooks.hooks?.Stop?.[0]?.hooks?.[0]
      expect(stopCommand).toEqual({
        type: 'command',
        command: 'if [ -n "${HRC_LAUNCH_HOOK_CLI:-}" ]; then bun "$HRC_LAUNCH_HOOK_CLI"; fi',
        statusMessage: 'capturing Codex turn',
      })
    })

    test('pins the default codex model when the target does not specify one', async () => {
      const input = composeTargetInput('test-target', [
        codexArtifact('space1@abc', artifact1Dir, '1.0.0'),
      ])

      await adapter.composeTarget(input, outputDir, { clean: true })

      const configRaw = await readFile(join(outputDir, 'codex.home', 'config.toml'), 'utf-8')
      const parsed = TOML.parse(configRaw) as Record<string, unknown>
      expect(parsed['model']).toBe('gpt-5.6-terra')
      expect(parsed['model_reasoning_effort']).toBe('high')
      expect(parsed['model_reasoning_summary']).toBe('detailed')
      expect((parsed['features'] as Record<string, unknown>)['hooks']).toBe(true)
      expect((parsed['tui'] as Record<string, unknown>)['status_line']).toEqual([
        'model-with-reasoning',
        'context-remaining',
        'current-dir',
      ])
    })

    test('includes a selected skill directory symlink', async () => {
      const externalSkill = join(tmpDir, 'external-explainer')
      await mkdir(externalSkill, { recursive: true })
      await writeFile(join(externalSkill, 'SKILL.md'), '# Explainer\n')
      await symlink(externalSkill, join(artifact2Dir, 'skills', 'explainer'))
      const input = composeTargetInput('symlink-target', [
        codexArtifact('space2@def', artifact2Dir, '2.0.0'),
      ])

      await adapter.composeTarget(input, outputDir, { clean: true })
      const selected = join(outputDir, 'codex.home', 'skills', 'explainer')
      await expect(readFile(join(selected, 'SKILL.md'), 'utf8')).resolves.toBe('# Explainer\n')
      expect((await lstat(selected)).isSymbolicLink()).toBe(true)
      expect(await readlink(selected)).toBe(externalSkill)
    })
  })
})
