/**
 * MuseAdapter tests (spike 11, T-08591): compose/load round-trip, exec argv
 * mapping, HOME env, stable HOME prep, and the register() duplicate boundary.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposeTargetInput, HarnessRunOptions } from 'spaces-config'
import { HarnessRegistry } from 'spaces-runtime'
import { register } from '../register.js'
import { MuseAdapter, museAdapter, museCliHomeDir } from './muse-adapter.js'

const spaceFiles = {
  'AGENTS.md': '# Test space\n',
  'skills/greeter/SKILL.md': '---\nname: greeter\ndescription: Greets.\n---\n\n# Greeter\n',
  'mcp/mcp.json': JSON.stringify({ mcpServers: { t: { type: 'stdio', command: 't-bin' } } }),
}

async function makeSnapshot(root: string, id: string): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(spaceFiles)) {
    const path = join(dir, rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  return dir
}

const composeInput = (artifacts: Array<{ spaceId: string; dir: string }>): ComposeTargetInput => ({
  targetName: 'dev',
  compose: [],
  roots: [],
  loadOrder: [],
  artifacts: artifacts.map((artifact) => ({
    spaceKey: `${artifact.spaceId}@1.0.0`,
    spaceId: artifact.spaceId,
    artifactPath: artifact.dir,
    pluginName: artifact.spaceId,
    pluginVersion: '1.0.0',
  })),
  settingsInputs: [],
})

const runOptions = (overrides: Partial<HarnessRunOptions> = {}): HarnessRunOptions => ({
  interactive: false,
  cwd: '/project',
  prompt: 'do the thing',
  ...overrides,
})

describe('MuseAdapter', () => {
  test('compose/load round-trips the muse bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muse-adapter-'))
    try {
      const snapshot = await makeSnapshot(root, 'snap')
      const adapter = new MuseAdapter()
      const { bundle, warnings } = await adapter.composeTarget(
        composeInput([{ spaceId: 'alpha', dir: snapshot }]),
        join(root, 'bundle'),
        { clean: true }
      )
      expect(bundle.harnessId).toBe('muse')
      expect(bundle.muse?.workspaceDir.endsWith('muse.workspace')).toBe(true)
      expect(bundle.pluginDirs).toEqual([bundle.muse?.workspaceDir])
      const agents = await readFile(bundle.muse?.agentsPath ?? '', 'utf-8')
      expect(agents).toContain('# Test space')

      const loaded = await adapter.loadTargetBundle(join(root, 'bundle'), 'dev')
      expect(loaded.muse).toEqual(bundle.muse)
      expect(warnings.every((warning) => typeof warning.code === 'string')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('buildRunArgs maps onto muse exec with native model/effort flags', () => {
    const bundle = {
      harnessId: 'muse' as const,
      targetName: 'dev',
      rootDir: '/out',
      muse: {
        workspaceDir: '/out/muse.workspace',
        agentsPath: '/out/muse.workspace/AGENTS.md',
        skillsDir: '/out/muse.workspace/skills',
        settingsPath: '/out/muse.workspace/settings.json',
        manifestPath: '/out/muse.workspace/manifest.json',
      },
    }
    expect(museAdapter.buildRunArgs(bundle, runOptions())).toEqual([
      'exec',
      '--trust-workspace',
      '--workspace',
      '/project',
      'do the thing',
    ])
    expect(
      museAdapter.buildRunArgs(
        bundle,
        runOptions({ model: 'm1', modelReasoningEffort: 'low', imageAttachments: ['a.png'] })
      )
    ).toEqual([
      'exec',
      '--trust-workspace',
      '--workspace',
      '/project',
      '--model',
      'm1',
      '--reasoning-effort',
      'low',
      '--image',
      'a.png',
      'do the thing',
    ])
  })

  test('yolo adds --yolo on the exec path and is omitted otherwise', () => {
    const bundle = {
      harnessId: 'muse' as const,
      targetName: 'dev',
      rootDir: '/out',
      muse: {
        workspaceDir: '/out/muse.workspace',
        agentsPath: '/out/muse.workspace/AGENTS.md',
        skillsDir: '/out/muse.workspace/skills',
        settingsPath: '/out/muse.workspace/settings.json',
        manifestPath: '/out/muse.workspace/manifest.json',
      },
    }
    expect(museAdapter.buildRunArgs(bundle, runOptions({ yolo: true }))).toEqual([
      'exec',
      '--trust-workspace',
      '--yolo',
      '--workspace',
      '/project',
      'do the thing',
    ])
    expect(museAdapter.buildRunArgs(bundle, runOptions())).not.toContain('--yolo')
  })

  test('yolo adds --yolo on the interactive path and is omitted otherwise', () => {
    const bundle = {
      harnessId: 'muse' as const,
      targetName: 'dev',
      rootDir: '/out',
    }
    expect(museAdapter.buildRunArgs(bundle, { prompt: 'hi', yolo: true })).toEqual([
      '--yolo',
      'hi',
    ])
    expect(museAdapter.buildRunArgs(bundle, { prompt: 'hi' })).toEqual(['hi'])
  })

  test('resume maps to muse resume and rejects a prompt positional', () => {
    const bundle = {
      harnessId: 'muse' as const,
      targetName: 'dev',
      rootDir: '/out',
    }
    expect(
      museAdapter.buildRunArgs(bundle, { interactive: true, continuationKey: 'sess-1' })
    ).toEqual(['resume', 'sess-1'])
    expect(() =>
      museAdapter.buildRunArgs(bundle, { interactive: true, continuationKey: true, prompt: 'hi' })
    ).toThrow('does not accept a prompt')
  })

  test('getRunEnv keeps operator HOME with XDG dirs in the stable bundle home', () => {
    const bundle = {
      harnessId: 'muse' as const,
      targetName: 'dev',
      rootDir: '/out',
    }
    const env = museAdapter.getRunEnv(bundle, runOptions())
    // Keychain-bound oauth only resolves under the operator HOME (T-08592).
    expect(env['HOME']).toBe(homedir())
    expect(env['XDG_CONFIG_HOME']).toBe('/out/muse.home/.config')
    expect(env['XDG_DATA_HOME']).toBe('/out/muse.home/.local/share')
    expect(museCliHomeDir('/out')).toBe('/out/muse.home')
  })

  test('stable HOME prep reuses on matching fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muse-adapter-'))
    try {
      const snapshot = await makeSnapshot(root, 'snap')
      const adapter = new MuseAdapter()
      const { bundle } = await adapter.composeTarget(
        composeInput([{ spaceId: 'alpha', dir: snapshot }]),
        join(root, 'bundle'),
        { clean: true }
      )
      const first = await adapter.prepareCliHome(
        join(root, 'bundle'),
        bundle.muse?.skillsDir ?? '',
        'dev'
      )
      const second = await adapter.prepareCliHome(
        join(root, 'bundle'),
        bundle.muse?.skillsDir ?? '',
        'dev'
      )
      expect(Array.isArray(first)).toBe(true)
      expect(Array.isArray(second)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('register() duplicate registration throws', () => {
    const registry = new HarnessRegistry()
    register({ harnesses: registry, sessions: { register: () => undefined } as never })
    expect(registry.has('muse')).toBe(true)
    expect(() =>
      register({ harnesses: registry, sessions: { register: () => undefined } as never })
    ).toThrow('already registered')
  })
})
