/**
 * Unit tests for `asp self` shared helpers.
 *
 * Covers pure functions that can be tested without spawning the CLI:
 * - extractSystemPrompt / extractPrimingPrompt (argv parsing)
 * - inferTargetFromBundleRoot (path walking)
 * - readLaunchArtifactLite (lenient JSON parsing)
 * - resolveSelfContext (env + launch file integration)
 * - enumeratePaths (path classification)
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  enumeratePaths,
  extractPrimingPrompt,
  extractSystemPrompt,
  filterInjectedEnv,
  inferTargetFromBundleRoot,
  readLaunchArtifactLite,
  resolveSelfContext,
} from '../lib.js'

const tempDirs: string[] = []
const SAMPLE_PREFIX = 'EXAMPLE_'

afterEach(async () => {
  await Promise.all(tempDirs.map((p) => rm(p, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('extractSystemPrompt', () => {
  test('returns append mode when --append-system-prompt is present', () => {
    const argv = ['claude', '--append-system-prompt', 'hello', '--', 'prime']
    expect(extractSystemPrompt(argv)).toEqual({ content: 'hello', mode: 'append' })
  })

  test('returns replace mode when --system-prompt is present', () => {
    const argv = ['codex', '--system-prompt', 'replaces-it', 'prime']
    expect(extractSystemPrompt(argv)).toEqual({ content: 'replaces-it', mode: 'replace' })
  })

  test('prefers append over replace when both present', () => {
    const argv = ['x', '--append-system-prompt', 'a', '--system-prompt', 'b']
    expect(extractSystemPrompt(argv)?.mode).toBe('append')
  })

  test('returns null when neither flag is present', () => {
    expect(extractSystemPrompt(['x', '-y'])).toBeNull()
  })

  test('returns null when flag has no value', () => {
    expect(extractSystemPrompt(['--append-system-prompt'])).toBeNull()
  })
})

describe('extractPrimingPrompt', () => {
  test('returns argument after --', () => {
    const argv = ['claude', '--flag', '--', 'priming text']
    expect(extractPrimingPrompt(argv)).toBe('priming text')
  })

  test('returns null when -- is absent', () => {
    expect(extractPrimingPrompt(['x', 'y'])).toBeNull()
  })

  test('returns null when -- is the last argument', () => {
    expect(extractPrimingPrompt(['x', '--'])).toBeNull()
  })

  test('returns null for empty string after --', () => {
    expect(extractPrimingPrompt(['x', '--', ''])).toBeNull()
  })
})

describe('inferTargetFromBundleRoot', () => {
  test('extracts target from bundle path', () => {
    const bundle = '/home/lherron/spaces/codex-homes/agent-spaces_clod/bundles/clod/claude'
    expect(inferTargetFromBundleRoot(bundle)).toBe('clod')
  })

  test('returns null for undefined input', () => {
    expect(inferTargetFromBundleRoot(undefined)).toBeNull()
  })

  test('returns null for root path', () => {
    expect(inferTargetFromBundleRoot('/')).toBeNull()
  })
})

describe('readLaunchArtifactLite', () => {
  test('parses valid JSON artifact', async () => {
    const dir = await makeTempDir('asp-self-launch-')
    const path = join(dir, 'launch.json')
    await writeFile(path, JSON.stringify({ launchId: 'L1', argv: ['claude'], env: { X: 'Y' } }))
    const result = readLaunchArtifactLite(path)
    expect(result.error).toBeNull()
    expect(result.artifact?.launchId).toBe('L1')
    expect(result.artifact?.env?.['X']).toBe('Y')
  })

  test('returns error for malformed JSON', async () => {
    const dir = await makeTempDir('asp-self-launch-')
    const path = join(dir, 'bad.json')
    await writeFile(path, '{not json')
    const result = readLaunchArtifactLite(path)
    expect(result.artifact).toBeNull()
    expect(result.error).toBeTruthy()
  })

  test('returns error for non-object JSON', async () => {
    const dir = await makeTempDir('asp-self-launch-')
    const path = join(dir, 'arr.json')
    await writeFile(path, '[]')
    const result = readLaunchArtifactLite(path)
    expect(result.artifact).toBeNull()
    expect(result.error).toContain('not an object')
  })

  test('tolerates missing fields', async () => {
    const dir = await makeTempDir('asp-self-launch-')
    const path = join(dir, 'partial.json')
    await writeFile(path, JSON.stringify({ launchId: 'only-id' }))
    const result = readLaunchArtifactLite(path)
    expect(result.error).toBeNull()
    expect(result.artifact?.launchId).toBe('only-id')
  })
})

describe('resolveSelfContext', () => {
  test('uses live self env when no launch file is available', async () => {
    const dir = await makeTempDir('asp-self-ctx-')
    const agentsDir = join(dir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    const ctx = resolveSelfContext({
      env: {
        ASP_AGENT_ID: 'smokey',
        ASP_PROJECT: 'test-proj',
        ASP_SCOPE_REF: 'agent:smokey:project:test-proj:task:codex-test',
        HRC_SESSION_REF: 'agent:smokey:project:test-proj:task:codex-test/lane:main',
        ASP_PRIMING_PROMPT: 'go',
        PATH: '/bin',
      },
      cwd: dir,
      aspHome: dir,
      agentsRoot: agentsDir,
    })
    expect(ctx.agentName).toBe('smokey')
    expect(ctx.projectId).toBe('test-proj')
    expect(ctx.envSource).toBe('live-env')
    expect(ctx.primingPrompt).toBe('go')
    expect(ctx.injectedEnv).toEqual({
      ASP_AGENT_ID: 'smokey',
      ASP_PRIMING_PROMPT: 'go',
      ASP_PROJECT: 'test-proj',
      ASP_SCOPE_REF: 'agent:smokey:project:test-proj:task:codex-test',
      HRC_SESSION_REF: 'agent:smokey:project:test-proj:task:codex-test/lane:main',
    })
    expect(ctx.lookup('missing')).toBeNull()
    expect(ctx.launch).toBeNull()
    expect(ctx.agentRoot).toBe(join(agentsDir, 'smokey'))
  })

  test('filters injected env with generic shell noise rules', () => {
    expect(
      filterInjectedEnv({
        AGENTCHAT_ID: 'clod',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        PATH: '/bin',
        SHELL: '/bin/zsh',
        [`${SAMPLE_PREFIX}RUNTIME_ID`]: 'rt-TEST',
      })
    ).toEqual({
      AGENTCHAT_ID: 'clod',
      [`${SAMPLE_PREFIX}RUNTIME_ID`]: 'rt-TEST',
    })
  })

  test('extracts prompts from launch artifact argv', async () => {
    const dir = await makeTempDir('asp-self-ctx-')
    const agentsDir = join(dir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    const launchPath = join(dir, 'launch.json')
    await writeFile(
      launchPath,
      JSON.stringify({
        launchId: 'LX',
        harness: 'claude-code',
        provider: 'anthropic',
        argv: ['claude', '--append-system-prompt', 'SYS-CONTENT', '--', 'PRIME-CONTENT'],
        env: {
          AGENTCHAT_ID: 'agent',
          ASP_PROJECT: 'test-proj',
          [`${SAMPLE_PREFIX}LAUNCH_ID`]: 'LX',
          [`${SAMPLE_PREFIX}RUNTIME_ID`]: 'rt-artifact',
          PATH: '/bin',
        },
      })
    )
    const ctx = resolveSelfContext({
      env: { AGENT_LAUNCH_FILE: launchPath },
      cwd: dir,
      aspHome: dir,
      agentsRoot: agentsDir,
    })
    expect(ctx.agentName).toBe('agent')
    expect(ctx.projectId).toBe('test-proj')
    expect(ctx.envSource).toBe('launch-artifact')
    expect(ctx.systemPrompt).toEqual({ content: 'SYS-CONTENT', mode: 'append' })
    expect(ctx.primingPrompt).toBe('PRIME-CONTENT')
    expect(ctx.harness).toBe('claude-code')
    expect(ctx.provider).toBe('anthropic')
    expect(ctx.injectedEnv).toEqual({
      AGENTCHAT_ID: 'agent',
      ASP_PROJECT: 'test-proj',
      [`${SAMPLE_PREFIX}LAUNCH_ID`]: 'LX',
      [`${SAMPLE_PREFIX}RUNTIME_ID`]: 'rt-artifact',
    })
    expect(ctx.lookup(`${SAMPLE_PREFIX}RUNTIME_ID`)).toBe('rt-artifact')
    expect(ctx.lookup('PATH')).toBeNull()
  })

  test('reports launch read error without throwing', () => {
    const ctx = resolveSelfContext({
      env: { AGENT_LAUNCH_FILE: '/nonexistent/path/xyz.json' },
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    expect(ctx.launch).toBeNull()
    expect(ctx.launchReadError).toContain('not found')
  })

  test('artifact agent target overrides bundle inference', async () => {
    const dir = await makeTempDir('asp-self-ctx-')
    const launchPath = join(dir, 'launch.json')
    await writeFile(
      launchPath,
      JSON.stringify({
        env: {
          AGENTCHAT_ID: 'explicit',
          ASP_PLUGIN_ROOT: '/a/b/codex-homes/p_explicit/bundles/from-bundle/claude',
        },
      })
    )
    const ctx = resolveSelfContext({
      env: { AGENT_LAUNCH_FILE: launchPath },
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    expect(ctx.agentName).toBe('explicit')
  })

  test('infers agent name from artifact bundle root when AGENTCHAT_ID is missing', async () => {
    const dir = await makeTempDir('asp-self-ctx-')
    const launchPath = join(dir, 'launch.json')
    await writeFile(
      launchPath,
      JSON.stringify({
        env: { ASP_PLUGIN_ROOT: '/a/b/codex-homes/p_inferred/bundles/inferred/claude' },
      })
    )
    const ctx = resolveSelfContext({
      env: { AGENT_LAUNCH_FILE: launchPath },
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    expect(ctx.agentName).toBe('inferred')
  })

  test('options.target overrides everything', () => {
    const ctx = resolveSelfContext({
      target: 'override',
      env: { AGENTCHAT_ID: 'other' },
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    expect(ctx.agentName).toBe('override')
  })

  test('controller process env does not affect injected env output', async () => {
    const dir = await makeTempDir('asp-self-ctx-')
    const agentsDir = join(dir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    const launchPath = join(dir, 'launch.json')
    await writeFile(
      launchPath,
      JSON.stringify({
        argv: [],
        env: {
          AGENTCHAT_ID: 'agent',
          [`${SAMPLE_PREFIX}RUNTIME_ID`]: 'rt-artifact',
        },
      })
    )

    const ctx = resolveSelfContext({
      env: {
        AGENT_LAUNCH_FILE: launchPath,
        [`${SAMPLE_PREFIX}RUNTIME_ID`]: 'rt-process',
      },
      cwd: dir,
      aspHome: dir,
      agentsRoot: agentsDir,
    })

    expect(ctx.injectedEnv[`${SAMPLE_PREFIX}RUNTIME_ID`]).toBe('rt-artifact')
    expect(Object.values(ctx.injectedEnv)).not.toContain('rt-process')
  })

  test('reports no env source when no launch or live self env is available', () => {
    const ctx = resolveSelfContext({
      env: { PATH: '/bin' },
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    expect(ctx.envSource).toBe('none')
    expect(ctx.agentName).toBeNull()
    expect(ctx.projectId).toBeNull()
    expect(ctx.injectedEnv).toEqual({})
  })
})

describe('enumeratePaths', () => {
  test('classifies agent-local, shared, derived, and ephemeral paths', async () => {
    const dir = await makeTempDir('asp-self-paths-')
    const agentsDir = join(dir, 'agents')
    await mkdir(join(agentsDir, 'clod'), { recursive: true })
    await writeFile(join(agentsDir, 'clod', 'SOUL.md'), '# clod')
    const launchPath = join(dir, 'launch.json')
    await writeFile(
      launchPath,
      JSON.stringify({
        env: {
          ASP_PLUGIN_ROOT: join(dir, 'bundle'),
        },
      })
    )

    const ctx = resolveSelfContext({
      target: 'clod',
      env: {
        AGENT_LAUNCH_FILE: launchPath,
      },
      aspHome: dir,
      agentsRoot: agentsDir,
    })
    const entries = enumeratePaths(ctx)

    const soul = entries.find((e) => e.name === 'soul')
    expect(soul?.kind).toBe('editable')
    expect(soul?.exists).toBe(true)

    const motd = entries.find((e) => e.name === 'shared-motd')
    expect(motd?.kind).toBe('shared-editable')

    const bundle = entries.find((e) => e.name === 'bundle-root')
    expect(bundle?.kind).toBe('derived')

    const launch = entries.find((e) => e.name === 'launch-file')
    expect(launch?.kind).toBe('ephemeral')
  })

  test('skips entries without a resolvable path', () => {
    const ctx = resolveSelfContext({
      env: {}, // no target, no bundle
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    const entries = enumeratePaths(ctx)
    // shared paths still enumerate because agentsRoot is always resolved
    expect(entries.some((e) => e.name === 'shared-motd')).toBe(true)
    // agent-local paths should not appear without a target
    expect(entries.some((e) => e.name === 'soul')).toBe(false)
    // bundle paths should not appear without ASP_PLUGIN_ROOT
    expect(entries.some((e) => e.name === 'bundle-root')).toBe(false)
  })
})
