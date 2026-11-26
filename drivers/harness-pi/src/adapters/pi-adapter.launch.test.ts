import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposedTargetBundle, ProjectManifest } from 'spaces-config'
import { PiAdapter } from './pi-adapter.js'

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

describe('PiAdapter', () => {
  const adapter = new PiAdapter()

  describe('buildRunArgs', () => {
    let tmpDir: string
    let extensionsDir: string
    let bundle: ComposedTargetBundle

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'pi-args-'))
      extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir)
      bundle = { harnessId: 'pi', targetName: 'test', rootDir: tmpDir, pi: { extensionsDir } }
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('builds args with extension flags', async () => {
      await writeFile(join(extensionsDir, 'tool1.js'), 'export default {}')
      await writeFile(join(extensionsDir, 'tool2.js'), 'export default {}')

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--extension')
      expect(args.filter((a) => a === '--extension')).toHaveLength(2)
    })

    test('builds args with hook bridge extension', () => {
      bundle.pi!.hookBridgePath = join(tmpDir, 'asp-hooks.bridge.js')

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--extension')
      expect(args).toContain(join(tmpDir, 'asp-hooks.bridge.js'))
    })

    test('adds --no-skills to disable default skill loading', () => {
      bundle.pi!.skillsDir = join(tmpDir, 'skills')

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-skills')
    })

    test('passes replacement system prompt file path with --system-prompt', async () => {
      const systemPromptPath = join(tmpDir, 'system-prompt.md')
      await writeFile(systemPromptPath, 'system prompt')

      const args = adapter.buildRunArgs(bundle, { systemPrompt: systemPromptPath })

      expect(argValue(args, '--system-prompt')).toBe(systemPromptPath)
    })

    test('passes session reminder file path after replacement system prompt', async () => {
      const systemPromptPath = join(tmpDir, 'system-prompt.md')
      const reminderPath = join(tmpDir, 'session-reminder.md')
      await writeFile(systemPromptPath, 'system prompt')
      await writeFile(reminderPath, 'remember this')

      const args = adapter.buildRunArgs(bundle, {
        systemPrompt: systemPromptPath,
        reminderContent: reminderPath,
      })

      expect(argValue(args, '--append-system-prompt')).toBe(reminderPath)
      expect(args.indexOf('--append-system-prompt')).toBeGreaterThan(
        args.indexOf('--system-prompt')
      )
    })

    test('passes explicit bundle skills directory while keeping --no-skills', async () => {
      const skillsDir = join(tmpDir, 'skills')
      await mkdir(join(skillsDir, 'skill-one'), { recursive: true })

      bundle.pi!.skillsDir = skillsDir

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-skills')
      expect(argValue(args, '--skill')).toBe(skillsDir)
    })

    test('always disables native Pi context files', () => {
      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-context-files')
    })

    test('uses named Pi session and HRC runtime session dir for continuation keys', () => {
      const aspHome = join(tmpDir, 'asp-home')

      const args = adapter.buildRunArgs(bundle, {
        aspHome,
        continuationKey: 'session-a',
        runtimeId: 'rt-123',
      } as any)

      expect(argValue(args, '--session')).toBe('session-a')
      expect(argValue(args, '--session-dir')).toBe(
        join(aspHome, 'state/hrc/runtimes/rt-123/pi-sessions')
      )
      expect(args).not.toContain('--resume')
    })

    test('uses bundle-local session dir for continuation keys outside HRC runtime launches', () => {
      const args = adapter.buildRunArgs(bundle, { continuationKey: 'session-b' })

      expect(argValue(args, '--session')).toBe('session-b')
      expect(argValue(args, '--session-dir')).toBe(join(tmpDir, 'sessions'))
      expect(args).not.toContain('--resume')
    })

    test('keeps --resume only for explicit continuation picker requests', () => {
      const args = adapter.buildRunArgs(bundle, { continuationKey: true })

      expect(args).toContain('--resume')
      expect(args).not.toContain('--session')
      expect(args).not.toContain('--session-dir')
    })

    test('always adds the HRC events bridge extension', async () => {
      const hrcBridgePath = join(tmpDir, 'asp-hrc-events.bridge.js')
      await writeFile(hrcBridgePath, 'export default {}')

      bundle.pi!.hrcEventsBridgePath = hrcBridgePath

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--extension')
      expect(args).toContain(hrcBridgePath)
    })

    test('keeps priming prompt as positional argv tail and exposes it in run env', () => {
      const prompt = 'Prime the interactive session.'

      const args = adapter.buildRunArgs(bundle, { prompt })
      const env = adapter.getRunEnv(bundle, { prompt })

      expect(args.at(-1)).toBe(prompt)
      expect(env['ASP_PRIMING_PROMPT']).toBe(prompt)
    })

    test('translates model names', () => {
      const models = [
        ['sonnet', 'claude-sonnet'],
        ['opus', 'claude-opus'],
        ['haiku', 'claude-haiku'],
      ] as const
      for (const [model, translated] of models) {
        const args = adapter.buildRunArgs(bundle, { model })
        expect(args).toContain('--model')
        expect(args).toContain(translated)
      }
    })

    test('passes through unknown model names', () => {
      const args = adapter.buildRunArgs(bundle, { model: 'gpt-4' })
      expect(args).toContain('--model')
      expect(args).toContain('gpt-4')
    })

    test('includes extra args', () => {
      const args = adapter.buildRunArgs(bundle, { extraArgs: ['--verbose', '--debug'] })

      expect(args).toContain('--verbose')
      expect(args).toContain('--debug')
    })

    test('does not include project path (Pi uses cwd)', () => {
      const args = adapter.buildRunArgs(bundle, { projectPath: '/my/project' })

      // Pi uses cwd, not a positional path argument
      expect(args).not.toContain('/my/project')
    })

    test('throws when no pi bundle', () => {
      const missingPiBundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
      }

      expect(() => adapter.buildRunArgs(missingPiBundle, {})).toThrow('Pi bundle is missing')
    })

    test('adds --no-extensions when no extensions found', () => {
      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-extensions')
    })
  })
})

describe('getRunEnv', () => {
  test('always sets PI_CODING_AGENT_DIR to the bundle root', () => {
    const adapter = new PiAdapter()
    const bundle = {
      harnessId: 'pi' as const,
      targetName: 'test',
      rootDir: '/bundle/root',
      pi: { extensionsDir: '/bundle/root/extensions' },
    }

    const env = adapter.getRunEnv(bundle, {})

    expect(env['PI_CODING_AGENT_DIR']).toBe('/bundle/root')
    expect(env['ASP_PRIMING_PROMPT']).toBeUndefined()
  })

  test('exposes the priming prompt via ASP_PRIMING_PROMPT when provided', () => {
    const adapter = new PiAdapter()
    const bundle = {
      harnessId: 'pi' as const,
      targetName: 'test',
      rootDir: '/bundle/root',
      pi: { extensionsDir: '/bundle/root/extensions' },
    }

    const env = adapter.getRunEnv(bundle, { prompt: 'go' })

    expect(env['PI_CODING_AGENT_DIR']).toBe('/bundle/root')
    expect(env['ASP_PRIMING_PROMPT']).toBe('go')
  })
})

describe('getDefaultRunOptions', () => {
  test('returns an empty options object (Pi opts out of defaults)', () => {
    const adapter = new PiAdapter()
    const manifest: ProjectManifest = { schema: 2, targets: { 'some-target': { compose: [] } } }

    const options = adapter.getDefaultRunOptions(manifest, 'some-target')

    expect(options).toEqual({})
  })
})
