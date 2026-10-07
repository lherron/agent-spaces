/**
 * CodexAdapter run surface: argv, model catalog, manifest run defaults, and run env.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { ProjectManifest } from 'spaces-config'
import { CodexAdapter } from './codex-adapter.js'

describe('CodexAdapter', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
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

      expect(args.slice(0, 2)).toEqual(['--enable', 'goals'])
      expect(args).toContain('--no-alt-screen')
      expect(args).toContain('Start by checking failing tests')
      expect(args).not.toContain('exec')
    })

    test('disables the alternate screen for interactive resume', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: true,
        continuationKey: 'codex-session-123',
      })

      expect(args).toContain('--no-alt-screen')
    })

    test('never emits a Codex profile selector (T-08581)', () => {
      const withProfile = { profile: 'meta' } as Record<string, unknown>
      for (const options of [
        { interactive: false, ...withProfile },
        { interactive: true, ...withProfile },
        { interactive: true, continuationKey: 'codex-session-123', ...withProfile },
      ]) {
        const args = adapter.buildRunArgs(bundle, options)
        expect(args).not.toContain('--profile')
        expect(args.some((arg) => arg.startsWith('profile='))).toBe(false)
      }
    })

    test('uses app-server mode in non-interactive runs', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: false,
        prompt: 'Summarize repository health',
      })

      expect(args).toEqual(['--enable', 'goals', 'app-server'])
      expect(args).not.toContain('Summarize repository health')
      expect(args).not.toContain('--no-alt-screen')
    })

    test('interactive mode bypasses codex hook trust so the Stop hook fires (T-01798)', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: true,
        prompt: 'Run a command',
      })

      expect(args).toContain('--dangerously-bypass-hook-trust')
    })

    test('headless app-server runs never carry the hook-trust bypass flag (T-01798)', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: false,
        prompt: 'Summarize repository health',
      })

      expect(args).not.toContain('--dangerously-bypass-hook-trust')
    })

    test('keeps headless model reasoning effort out of app-server argv', () => {
      const args = adapter.buildRunArgs(bundle, {
        interactive: false,
        modelReasoningEffort: 'high',
      })

      expect(args).toEqual(['--enable', 'goals', 'app-server'])
      expect(args).not.toContain('model_reasoning_effort="high"')
    })

    test('delivers model reasoning summary through CODEX_HOME, not app-server argv', () => {
      const args = adapter.buildRunArgs(bundle, { interactive: false })

      expect(args).toEqual(['--enable', 'goals', 'app-server'])
      expect(args.some((arg) => arg.includes('model_reasoning_summary'))).toBe(false)
    })

    test('marks GPT-5.6 Terra as the default and exposes every GPT-5.6 variant', () => {
      expect(adapter.models[0]).toEqual({
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6-Terra',
        default: true,
        identityKind: 'full',
      })
      expect(adapter.models.map((model) => model.id)).toEqual(
        expect.arrayContaining([
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-6-astra',
          'gpt-5.5',
        ])
      )
    })
  })

  describe('getDefaultRunOptions', () => {
    test('includes priming_prompt as default prompt', () => {
      const manifest: ProjectManifest = {
        schema: 2,
        targets: {
          codex: {
            compose: ['space:codex-space@stable'],
            priming: 'Register and send READY',
          },
        },
      }

      const defaults = adapter.getDefaultRunOptions(manifest, 'codex')
      expect(defaults.prompt).toBe('Register and send READY')
    })

    test('prefers target codex model_reasoning_effort over top-level defaults', () => {
      const manifest: ProjectManifest = {
        schema: 2,
        codex: {
          model_reasoning_effort: 'low',
        },
        targets: {
          codex: {
            compose: ['space:codex-space@stable'],
            provisioning: {
              codex: {
                model_reasoning_effort: 'high',
              },
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
})
