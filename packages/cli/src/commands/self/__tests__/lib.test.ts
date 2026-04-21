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
  inferTargetFromBundleRoot,
  readLaunchArtifactLite,
  resolveSelfContext,
} from '../lib.js'

const tempDirs: string[] = []

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
    const bundle = '/home/lherron/spaces/projects/proj-abc/targets/clod/claude'
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

  test('tolerates missing fields (unlike the strict hrc-server reader)', async () => {
    const dir = await makeTempDir('asp-self-launch-')
    const path = join(dir, 'partial.json')
    await writeFile(path, JSON.stringify({ launchId: 'only-id' }))
    const result = readLaunchArtifactLite(path)
    expect(result.error).toBeNull()
    expect(result.artifact?.launchId).toBe('only-id')
  })
})

describe('resolveSelfContext', () => {
  test('falls back to env when no launch file', async () => {
    const dir = await makeTempDir('asp-self-ctx-')
    const agentsDir = join(dir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    const ctx = resolveSelfContext({
      env: {
        AGENTCHAT_ID: 'smokey',
        ASP_PROJECT: 'test-proj',
        ASP_PRIMING_PROMPT: 'go',
        HRC_GENERATION: '3',
      },
      cwd: dir,
      aspHome: dir,
      agentsRoot: agentsDir,
    })
    expect(ctx.agentName).toBe('smokey')
    expect(ctx.projectId).toBe('test-proj')
    expect(ctx.primingPrompt).toBe('go')
    expect(ctx.generation).toBe(3)
    expect(ctx.launch).toBeNull()
    expect(ctx.agentRoot).toBe(join(agentsDir, 'smokey'))
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
      })
    )
    const ctx = resolveSelfContext({
      env: { AGENTCHAT_ID: 'agent', HRC_LAUNCH_FILE: launchPath },
      cwd: dir,
      aspHome: dir,
      agentsRoot: agentsDir,
    })
    expect(ctx.systemPrompt).toEqual({ content: 'SYS-CONTENT', mode: 'append' })
    expect(ctx.primingPrompt).toBe('PRIME-CONTENT')
    expect(ctx.harness).toBe('claude-code')
    expect(ctx.provider).toBe('anthropic')
    expect(ctx.launchId).toBe('LX')
  })

  test('reports launch read error without throwing', () => {
    const ctx = resolveSelfContext({
      env: { HRC_LAUNCH_FILE: '/nonexistent/path/xyz.json' },
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    expect(ctx.launch).toBeNull()
    expect(ctx.launchReadError).toContain('not found')
  })

  test('env target overrides bundle inference', () => {
    const ctx = resolveSelfContext({
      env: {
        AGENTCHAT_ID: 'explicit',
        ASP_PLUGIN_ROOT: '/a/b/projects/p/targets/from-bundle/claude',
      },
      aspHome: '/tmp',
      agentsRoot: '/tmp',
    })
    expect(ctx.agentName).toBe('explicit')
  })

  test('infers agent name from bundle root when AGENTCHAT_ID is missing', () => {
    const ctx = resolveSelfContext({
      env: { ASP_PLUGIN_ROOT: '/a/b/projects/p/targets/inferred/claude' },
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
})

describe('enumeratePaths', () => {
  test('classifies agent-local, shared, derived, and ephemeral paths', async () => {
    const dir = await makeTempDir('asp-self-paths-')
    const agentsDir = join(dir, 'agents')
    await mkdir(join(agentsDir, 'clod'), { recursive: true })
    await writeFile(join(agentsDir, 'clod', 'SOUL.md'), '# clod')

    const ctx = resolveSelfContext({
      target: 'clod',
      env: {
        ASP_PLUGIN_ROOT: join(dir, 'bundle'),
        HRC_LAUNCH_FILE: join(dir, 'missing.json'),
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
