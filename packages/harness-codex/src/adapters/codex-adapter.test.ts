/**
 * Tests for CodexAdapter
 *
 * WHY: CodexAdapter materializes spaces into codex artifacts and composes
 * deterministic codex.home templates. These tests verify the key mappings.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import TOML from '@iarna/toml'
import type {
  MaterializeSpaceInput,
  ProjectManifest,
  ResolvedSpaceManifest,
  SpaceKey,
} from 'spaces-config'
import { CodexAdapter, applyPraesidiumContextToCodexHome } from './codex-adapter.js'

function createTestManifest(overrides: Partial<ResolvedSpaceManifest> = {}): ResolvedSpaceManifest {
  return {
    id: 'test-space',
    name: 'Test Space',
    version: '1.0.0',
    ...overrides,
  }
}

function createSpaceKey(id = 'test-space', commit = 'abc123'): SpaceKey {
  return `${id}@${commit}` as SpaceKey
}

function createMaterializeInput(
  snapshotPath: string,
  manifestOverrides: Partial<ResolvedSpaceManifest> = {}
): MaterializeSpaceInput {
  return {
    spaceKey: createSpaceKey(),
    manifest: createTestManifest(manifestOverrides),
    snapshotPath,
    integrity: 'sha256-test',
  }
}

describe('CodexAdapter', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
  })

  describe('materializeSpace', () => {
    let tmpDir: string
    let snapshotDir: string
    let cacheDir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `codex-adapter-materialize-${Date.now()}`)
      snapshotDir = join(tmpDir, 'snapshot')
      cacheDir = join(tmpDir, 'cache')
      await mkdir(snapshotDir, { recursive: true })
      await mkdir(cacheDir, { recursive: true })

      await mkdir(join(snapshotDir, 'skills', 'alpha'), { recursive: true })
      await writeFile(join(snapshotDir, 'skills', 'alpha', 'SKILL.md'), '# Alpha')

      await mkdir(join(snapshotDir, 'commands'), { recursive: true })
      await writeFile(join(snapshotDir, 'commands', 'prompt.md'), '# Prompt')

      await mkdir(join(snapshotDir, 'mcp'), { recursive: true })
      await writeFile(
        join(snapshotDir, 'mcp', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            server: { type: 'stdio', command: 'cmd' },
          },
        })
      )

      await writeFile(join(snapshotDir, 'AGENTS.md'), 'Agents instructions')
      await writeFile(join(snapshotDir, 'AGENT.md'), 'Agent instructions')
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('materializes prompts, skills, mcp, and instructions', async () => {
      const input = createMaterializeInput(snapshotDir, {
        codex: {
          config: { 'features.web_search_request': false },
        },
      })

      const result = await adapter.materializeSpace(input, cacheDir, {
        force: true,
        useHardlinks: false,
      })

      expect(result.files).toContain('skills/alpha')
      expect(result.files).toContain('prompts/prompt.md')
      expect(result.files).toContain('mcp/mcp.json')
      expect(result.files).toContain('instructions.md')
      expect(result.files).toContain('codex.config.json')

      const instructions = await readFile(join(cacheDir, 'instructions.md'), 'utf-8')
      expect(instructions).toBe('Agents instructions')
    })

    test('skips prompts and skills when disabled', async () => {
      const input = createMaterializeInput(snapshotDir, {
        codex: {
          prompts: { enabled: false },
          skills: { enabled: false },
        },
      })

      const result = await adapter.materializeSpace(input, cacheDir, {
        force: true,
        useHardlinks: false,
      })

      expect(result.files).not.toContain('skills/alpha')
      expect(result.files).not.toContain('prompts/prompt.md')
    })
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

    test('composes codex.home with overrides and merged content', async () => {
      const input = {
        targetName: 'test-target',
        compose: [],
        roots: [],
        loadOrder: [],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'space1',
            pluginVersion: '1.0.0',
          },
          {
            spaceKey: 'space2@def' as SpaceKey,
            spaceId: 'space2',
            artifactPath: artifact2Dir,
            pluginName: 'space2',
            pluginVersion: '2.0.0',
          },
        ],
        settingsInputs: [],
        codexOptions: {
          model: 'gpt-5.3-codex',
          model_reasoning_effort: 'medium',
          status_line: ['model', 'context-remaining', 'git-branch'],
          approval_policy: 'on-request',
          sandbox_mode: 'danger-full-access',
          profile: 'default',
        },
      }

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
      expect(parsed['profile']).toBe('default')
      expect((parsed['features'] as Record<string, unknown>)['codex_hooks']).toBe(true)
      expect((parsed['tui'] as Record<string, unknown>)['status_line']).toEqual([
        'model',
        'context-remaining',
        'git-branch',
      ])

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
      const input = {
        targetName: 'test-target',
        compose: [],
        roots: [],
        loadOrder: [],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'space1',
            pluginVersion: '1.0.0',
          },
        ],
        settingsInputs: [],
      }

      await adapter.composeTarget(input, outputDir, { clean: true })

      const configRaw = await readFile(join(outputDir, 'codex.home', 'config.toml'), 'utf-8')
      const parsed = TOML.parse(configRaw) as Record<string, unknown>
      expect(parsed['model']).toBe('gpt-5.5')
      expect((parsed['features'] as Record<string, unknown>)['codex_hooks']).toBe(true)
      expect((parsed['tui'] as Record<string, unknown>)['status_line']).toEqual([
        'model-with-reasoning',
        'context-remaining',
        'current-dir',
      ])
    })
  })

  describe('buildRunArgs', () => {
    const bundle = {
      harnessId: 'codex' as const,
      targetName: 'test-target',
      rootDir: '/tmp/output',
      pluginDirs: ['/tmp/output/codex.home'],
    }

    test('passes prompt as positional arg in interactive mode', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: true,
        prompt: 'Start by checking failing tests',
      })

      expect(args).toContain('Start by checking failing tests')
      expect(args).not.toContain('exec')
    })

    test('uses exec mode in non-interactive runs', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: false,
        prompt: 'Summarize repository health',
      })

      expect(args[0]).toBe('exec')
      expect(args).toContain('Summarize repository health')
    })

    test('emits model reasoning effort as a config override', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: false,
        modelReasoningEffort: 'high',
      })

      expect(args).toContain('-c')
      expect(args).toContain('model_reasoning_effort="high"')
    })

    test('marks gpt-5.5 as the default supported model', () => {
      expect(adapter.models[0]).toEqual({ id: 'gpt-5.5', name: 'GPT-5.5', default: true })
    })
  })

  describe('getDefaultRunOptions', () => {
    test('includes priming_prompt as default prompt', () => {
      const manifest: ProjectManifest = {
        schema: 1,
        targets: {
          codex: {
            compose: ['space:codex-space@stable'],
            priming_prompt: 'Register and send READY',
          },
        },
      }

      const defaults = adapter.getDefaultRunOptions(manifest, 'codex')
      expect(defaults.prompt).toBe('Register and send READY')
    })

    test('prefers target codex model_reasoning_effort over top-level defaults', () => {
      const manifest: ProjectManifest = {
        schema: 1,
        codex: {
          model_reasoning_effort: 'low',
        },
        targets: {
          codex: {
            compose: ['space:codex-space@stable'],
            codex: {
              model_reasoning_effort: 'high',
            },
          },
        },
      }

      const defaults = adapter.getDefaultRunOptions(manifest, 'codex')
      expect(defaults.modelReasoningEffort).toBe('high')
    })
  })

  describe('getRunEnv', () => {
    test('uses provided codexHomeDir when set', () => {
      const env = adapter.getRunEnv(
        {
          harnessId: 'codex',
          targetName: 'test-target',
          rootDir: '/tmp/output',
          pluginDirs: ['/tmp/output/codex.home'],
          codex: {
            homeTemplatePath: '/tmp/output/codex.home',
            configPath: '/tmp/output/codex.home/config.toml',
            agentsPath: '/tmp/output/codex.home/AGENTS.md',
            skillsDir: '/tmp/output/codex.home/skills',
            promptsDir: '/tmp/output/codex.home/prompts',
          },
        },
        { codexHomeDir: '/tmp/output/codex.runtime' }
      )

      expect(env['CODEX_HOME']).toBe('/tmp/output/codex.runtime')
    })
  })

  describe('applyPraesidiumContextToCodexHome', () => {
    let workDir: string

    beforeEach(async () => {
      workDir = join(
        tmpdir(),
        `codex-praesidium-${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      await mkdir(workDir, { recursive: true })
    })

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true })
    })

    test('returns false and writes nothing when both inputs empty', async () => {
      const wrote = await applyPraesidiumContextToCodexHome(workDir, {})
      expect(wrote).toBe(false)
      const exists = await readFile(join(workDir, 'AGENTS.md')).catch(() => null)
      expect(exists).toBeNull()
    })

    test('appends praesidium block to existing AGENTS.md preserving prior content', async () => {
      await writeFile(join(workDir, 'AGENTS.md'), '# Space content\n\nfrom spaces\n')
      const wrote = await applyPraesidiumContextToCodexHome(workDir, {
        systemPrompt: 'I am Cody.',
        reminderContent: 'wrkq has 3 tasks.',
      })
      expect(wrote).toBe(true)
      const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
      expect(out).toContain('# Space content')
      expect(out).toContain('from spaces')
      expect(out).toContain('<!-- BEGIN praesidium-context -->')
      expect(out).toContain('I am Cody.')
      expect(out).toContain('wrkq has 3 tasks.')
      expect(out).toContain('<!-- END praesidium-context -->')
      // Order: system prompt before reminder
      expect(out.indexOf('I am Cody.')).toBeLessThan(out.indexOf('wrkq has 3 tasks.'))
    })

    test('creates AGENTS.md when none exists', async () => {
      const wrote = await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'soul only' })
      expect(wrote).toBe(true)
      const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
      expect(out).toContain('soul only')
      expect(out).toContain('<!-- BEGIN praesidium-context -->')
      expect(out).not.toContain('# Space content')
    })

    test('writes only systemPrompt when reminderContent is empty', async () => {
      await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'identity here' })
      const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
      const endMarker = '<!-- END praesidium-context -->'
      const block = out.slice(out.indexOf('<!-- BEGIN'), out.indexOf(endMarker) + endMarker.length)
      expect(block).toBe(
        '<!-- BEGIN praesidium-context -->\nidentity here\n<!-- END praesidium-context -->'
      )
    })

    test('writes only reminderContent when systemPrompt is empty', async () => {
      await applyPraesidiumContextToCodexHome(workDir, { reminderContent: 'wrkq state' })
      const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
      const endMarker = '<!-- END praesidium-context -->'
      const block = out.slice(out.indexOf('<!-- BEGIN'), out.indexOf(endMarker) + endMarker.length)
      expect(block).toBe(
        '<!-- BEGIN praesidium-context -->\nwrkq state\n<!-- END praesidium-context -->'
      )
    })

    test('replaces existing praesidium block on repeated calls (no accumulation)', async () => {
      await writeFile(join(workDir, 'AGENTS.md'), '# Space content\n')
      await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'first run' })
      await applyPraesidiumContextToCodexHome(workDir, { systemPrompt: 'second run' })
      const out = await readFile(join(workDir, 'AGENTS.md'), 'utf-8')
      expect(out).toContain('# Space content')
      expect(out).toContain('second run')
      expect(out).not.toContain('first run')
      // Exactly one praesidium block
      const beginCount = (out.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length
      const endCount = (out.match(/<!-- END praesidium-context -->/g) ?? []).length
      expect(beginCount).toBe(1)
      expect(endCount).toBe(1)
    })
  })
})
