import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent'
import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'

import { buildPiResourceLoaderOptions, buildResourceLoaderOptions } from './pi-session.js'
import type { PiSessionConfig, PiSessionStartOptions } from './types.js'

const RESOLVED = { cwd: '/work', agentDir: '/agent' }

function baseConfig(overrides: Partial<PiSessionConfig> = {}): PiSessionConfig {
  return { ownerId: 'owner', cwd: '/work', ...overrides }
}

function skill(name: string): Skill {
  return {
    name,
    description: `desc-${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: 'test' } as unknown as Skill['sourceInfo'],
    disableModelInvocation: false,
  }
}

// A factory is opaque to the loader options builder — identity is all we assert.
const extA = (() => ({})) as unknown as ExtensionFactory
const extB = (() => ({})) as unknown as ExtensionFactory

describe('buildResourceLoaderOptions (core)', () => {
  test('returns undefined when no inputs are present (default path preserved)', () => {
    expect(buildResourceLoaderOptions({}, RESOLVED)).toBeUndefined()
    expect(
      buildResourceLoaderOptions({ extensions: [], skills: [], contextFiles: [] }, RESOLVED)
    ).toBeUndefined()
  })

  test('carries cwd/agentDir and only the present inputs', () => {
    const opts = buildResourceLoaderOptions({ systemPrompt: 'only-sys' }, RESOLVED)
    expect(opts?.cwd).toBe('/work')
    expect(opts?.agentDir).toBe('/agent')
    expect(opts?.systemPrompt).toBe('only-sys')
    expect(opts?.extensionFactories).toBeUndefined()
    expect(opts?.skillsOverride).toBeUndefined()
    expect(opts?.agentsFilesOverride).toBeUndefined()
    expect(opts?.additionalExtensionPaths).toBeUndefined()
  })

  test('threads extensions + additionalExtensionPaths', () => {
    const opts = buildResourceLoaderOptions(
      { extensions: [extA, extB], additionalExtensionPaths: ['/ext/one'] },
      RESOLVED
    )
    expect(opts?.extensionFactories).toEqual([extA, extB])
    expect(opts?.additionalExtensionPaths).toEqual(['/ext/one'])
  })

  test('skillsOverride is ADDITIVE onto base skills and preserves base diagnostics', () => {
    const opts = buildResourceLoaderOptions({ skills: [skill('alpha'), skill('beta')] }, RESOLVED)
    const base = { skills: [skill('discovered')], diagnostics: [{ kind: 'x' }] as never[] }
    const merged = opts?.skillsOverride?.(base)
    expect(merged?.skills.map((s) => s.name)).toEqual(['discovered', 'alpha', 'beta'])
    // base skills never replaced; diagnostics passed through by reference.
    expect(merged?.diagnostics).toBe(base.diagnostics)
  })

  test('skillsOverride dedupes by name, supplied skill wins over discovered', () => {
    const opts = buildResourceLoaderOptions({ skills: [skill('shared')] }, RESOLVED)
    const discoveredShared = skill('shared')
    const merged = opts?.skillsOverride?.({ skills: [discoveredShared], diagnostics: [] })
    expect(merged?.skills).toHaveLength(1)
    expect(merged?.skills[0]).not.toBe(discoveredShared)
  })

  test('agentsFilesOverride preserves discovered AGENTS/CLAUDE files and appends explicit ones', () => {
    const opts = buildResourceLoaderOptions(
      { contextFiles: [{ path: 'CTX.md', content: 'ctx' }] },
      RESOLVED
    )
    const base = {
      agentsFiles: [
        { path: 'AGENTS.md', content: 'agents' },
        { path: 'CLAUDE.md', content: 'claude' },
      ],
    }
    const merged = opts?.agentsFilesOverride?.(base)
    expect(merged?.agentsFiles).toEqual([
      { path: 'AGENTS.md', content: 'agents' },
      { path: 'CLAUDE.md', content: 'claude' },
      { path: 'CTX.md', content: 'ctx' },
    ])
  })

  test('agentsFilesOverride duplicate-path policy: explicit content wins', () => {
    const opts = buildResourceLoaderOptions(
      { contextFiles: [{ path: 'AGENTS.md', content: 'injected' }] },
      RESOLVED
    )
    const merged = opts?.agentsFilesOverride?.({
      agentsFiles: [{ path: 'AGENTS.md', content: 'discovered' }],
    })
    expect(merged?.agentsFiles).toEqual([{ path: 'AGENTS.md', content: 'injected' }])
  })
})

describe('buildPiResourceLoaderOptions (config + start merge)', () => {
  test('returns undefined when neither config nor start supply inputs', () => {
    expect(buildPiResourceLoaderOptions(baseConfig(), {}, RESOLVED)).toBeUndefined()
  })

  test('merges config + start arrays (config first) and lets start override systemPrompt', () => {
    const config = baseConfig({
      systemPrompt: 'from-config',
      extensions: [extA],
      skills: [skill('cfg')],
      contextFiles: [{ path: 'cfg.md', content: 'c' }],
      additionalExtensionPaths: ['/cfg/ext'],
    })
    const start: PiSessionStartOptions = {
      systemPrompt: 'from-start',
      extensions: [extB],
      skills: [skill('start')],
      contextFiles: [{ path: 'start.md', content: 's' }],
    }
    const opts = buildPiResourceLoaderOptions(config, start, RESOLVED)
    expect(opts?.systemPrompt).toBe('from-start')
    expect(opts?.extensionFactories).toEqual([extA, extB])
    expect(opts?.additionalExtensionPaths).toEqual(['/cfg/ext'])
    const skills = opts?.skillsOverride?.({ skills: [], diagnostics: [] })
    expect(skills?.skills.map((s) => s.name)).toEqual(['cfg', 'start'])
    const files = opts?.agentsFilesOverride?.({ agentsFiles: [] })
    expect(files?.agentsFiles.map((f) => f.path)).toEqual(['cfg.md', 'start.md'])
  })

  test('config systemPrompt used when start omits it', () => {
    const opts = buildPiResourceLoaderOptions(
      baseConfig({ systemPrompt: 'from-config' }),
      {},
      RESOLVED
    )
    expect(opts?.systemPrompt).toBe('from-config')
  })
})

describe('INVARIANT: every supplied resource is visible through the loader after reload()', () => {
  function tmp(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix))
  }

  test('PiSession-shaped inputs all surface via DefaultResourceLoader.reload()', async () => {
    const resolved = { cwd: tmp('pi-rl-cwd-'), agentDir: tmp('pi-rl-agent-') }
    const opts = buildPiResourceLoaderOptions(
      baseConfig({
        systemPrompt: 'SYS',
        extensions: [extA],
        skills: [skill('sk-cfg')],
        contextFiles: [{ path: 'CTX.md', content: 'ctx' }],
      }),
      { skills: [skill('sk-start')] },
      resolved
    )
    expect(opts).toBeDefined()
    const loader = new DefaultResourceLoader(opts!)
    await loader.reload()
    expect(loader.getSystemPrompt()).toBe('SYS')
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['sk-cfg', 'sk-start'])
    )
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path)).toContain('CTX.md')
    expect(loader.getExtensions().extensions.length).toBeGreaterThanOrEqual(1)
  })

  test('runner-shaped inputs (bundle extensions/skills/context) all surface via reload()', async () => {
    const resolved = { cwd: tmp('pi-run-cwd-'), agentDir: tmp('pi-run-agent-') }
    const opts = buildResourceLoaderOptions(
      {
        extensions: [extA, extB],
        skills: [skill('bundle-skill')],
        contextFiles: [{ path: 'BUNDLE.md', content: 'bundle' }],
      },
      resolved
    )
    expect(opts).toBeDefined()
    const loader = new DefaultResourceLoader(opts!)
    await loader.reload()
    expect(loader.getExtensions().extensions.length).toBeGreaterThanOrEqual(2)
    expect(loader.getSkills().skills.map((s) => s.name)).toContain('bundle-skill')
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path)).toContain('BUNDLE.md')
  })
})
