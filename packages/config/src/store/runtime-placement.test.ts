import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildRuntimeBundleRef,
  findProjectMarker,
  inferProjectIdFromCwd,
  resolveAgentPlacementPaths,
} from './runtime-placement.js'

function writeAgentProfile(agentsRoot: string, agentId: string): string {
  const agentRoot = join(agentsRoot, agentId)
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'agent-profile.toml'), 'schemaVersion = 2\n')
  return agentRoot
}

describe('runtime placement helpers', () => {
  test('buildRuntimeBundleRef detects agent-project bundles', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-'))
    const agentRoot = join(tmp, 'agents', 'larry')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'schemaVersion = 2\n')

    expect(
      buildRuntimeBundleRef({
        agentName: 'larry',
        agentRoot,
        projectRoot: '/tmp/project',
      })
    ).toEqual({
      kind: 'agent-project',
      agentName: 'larry',
      projectRoot: '/tmp/project',
    })
  })

  test('buildRuntimeBundleRef throws when agentName provided without agentRoot', () => {
    expect(() => buildRuntimeBundleRef({ agentName: 'foo' })).toThrow(
      /agentRoot is required when agentName is provided/
    )
  })

  test('buildRuntimeBundleRef throws when agentRoot has no agent-profile.toml', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-noprofile-'))
    expect(() => buildRuntimeBundleRef({ agentName: 'foo', agentRoot: tmp })).toThrow(
      /agent-profile\.toml not found/
    )
  })

  test('buildRuntimeBundleRef throws when no selectors are provided', () => {
    expect(() => buildRuntimeBundleRef({})).toThrow(/no identifying selector provided/)
  })

  test('resolveAgentPlacementPaths finds projectRoot via asp-targets.toml marker walk-up', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-'))
    const agentsRoot = join(tmp, 'agents')
    const projectDir = join(tmp, 'projects', 'agent-spaces')
    mkdirSync(projectDir, { recursive: true })
    writeAgentProfile(agentsRoot, 'larry')
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\n')

    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        projectId: 'agent-spaces',
        cwd: projectDir,
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
        },
      })
    ).toEqual({
      agentRoot: join(agentsRoot, 'larry'),
      projectRoot: projectDir,
      cwd: projectDir,
    })
  })

  test('resolveAgentPlacementPaths honors ASP_PROJECT_ROOT_OVERRIDE', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-override-'))
    const agentsRoot = join(tmp, 'agents')
    const projectRoot = join(tmp, 'projects', 'raw2draft')
    writeAgentProfile(agentsRoot, 'larry')
    mkdirSync(projectRoot, { recursive: true })

    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        projectId: 'raw2draft',
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
        },
      })
    ).toEqual({
      agentRoot: join(agentsRoot, 'larry'),
      projectRoot,
      cwd: projectRoot,
    })
  })

  test('resolveAgentPlacementPaths expands ~ in ASP_PROJECT_ROOT_OVERRIDE', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-home-'))
    const home = join(tmp, 'home')
    mkdirSync(home, { recursive: true })

    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        projectId: 'raw2draft',
        env: {
          HOME: home,
          ASP_AGENTS_ROOT: '~/agents',
          ASP_PROJECT_ROOT_OVERRIDE: '~/tools/raw2draft',
        },
      })
    ).toEqual({
      projectRoot: join(home, 'tools/raw2draft'),
      searchedAgentRoots: [join(home, 'agents', 'larry')],
      cwd: join(home, 'tools/raw2draft'),
    })
  })

  test('resolveAgentPlacementPaths ignores ASP_PROJECT_ROOT_OVERRIDE when projectId is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-noproject-'))
    const agentsRoot = join(tmp, 'agents')
    writeAgentProfile(agentsRoot, 'larry')

    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: '/opt/external/raw2draft',
        },
      })
    ).toEqual({
      agentRoot: join(agentsRoot, 'larry'),
      cwd: join(agentsRoot, 'larry'),
    })
  })

  test('resolveAgentPlacementPaths prefers project-local agents-root over canonical root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-local-'))
    const canonicalRoot = join(tmp, 'canonical')
    const projectDir = join(tmp, 'project')
    const localRoot = join(projectDir, 'agents')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
    writeAgentProfile(canonicalRoot, 'smokey')
    const localAgentRoot = writeAgentProfile(localRoot, 'smokey')

    expect(
      resolveAgentPlacementPaths({
        agentId: 'smokey',
        projectId: 'project',
        cwd: projectDir,
        env: { ASP_AGENTS_ROOT: canonicalRoot },
      })
    ).toEqual({
      agentRoot: localAgentRoot,
      projectRoot: projectDir,
      cwd: projectDir,
    })
  })

  test('resolveAgentPlacementPaths skips a declared-but-missing local root and falls back to canonical', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-missing-local-'))
    const canonicalRoot = join(tmp, 'canonical')
    const projectDir = join(tmp, 'project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
    const canonicalAgentRoot = writeAgentProfile(canonicalRoot, 'daedalus')

    expect(
      resolveAgentPlacementPaths({
        agentId: 'daedalus',
        projectId: 'project',
        cwd: projectDir,
        env: { ASP_AGENTS_ROOT: canonicalRoot },
      })
    ).toEqual({
      agentRoot: canonicalAgentRoot,
      projectRoot: projectDir,
      warnings: [`Declared project agents root does not exist: ${join(projectDir, 'agents')}`],
      cwd: projectDir,
    })
  })

  test('resolveAgentPlacementPaths exposes every searched agent root when not found', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-not-found-'))
    const canonicalRoot = join(tmp, 'canonical')
    const projectDir = join(tmp, 'project')
    const localRoot = join(projectDir, 'agents')
    mkdirSync(localRoot, { recursive: true })
    mkdirSync(canonicalRoot, { recursive: true })
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')

    expect(
      resolveAgentPlacementPaths({
        agentId: 'bench',
        projectId: 'project',
        cwd: projectDir,
        env: { ASP_AGENTS_ROOT: canonicalRoot },
      })
    ).toEqual({
      projectRoot: projectDir,
      searchedAgentRoots: [join(localRoot, 'bench'), join(canonicalRoot, 'bench')],
      cwd: projectDir,
    })
  })

  test('inferProjectIdFromCwd infers from cwd and ignores ASP_PROJECT', () => {
    // ASP_PROJECT must NOT short-circuit cwd inference: the function name
    // promises cwd inference, and callers compose env precedence explicitly.
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-marker-'))
    const projectDir = join(tmp, 'agent-spaces')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\n')

    // Even with a conflicting ASP_PROJECT set, the cwd marker wins.
    expect(
      inferProjectIdFromCwd({
        env: { ASP_PROJECT: 'explicit-project' },
        cwd: projectDir,
      })
    ).toBe('agent-spaces')

    // No marker reachable (cwd outside any project) → undefined, regardless of
    // ASP_PROJECT.
    expect(
      inferProjectIdFromCwd({
        env: { ASP_PROJECT: 'explicit-project' },
        cwd: '/tmp',
      })
    ).toBeUndefined()
  })

  test('findProjectMarker walks up and stops at agentsRoot boundary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-walk-'))
    const projectDir = join(tmp, 'project-root')
    const subDir = join(projectDir, 'src', 'nested')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\n')

    expect(findProjectMarker(subDir)).toEqual({
      dir: projectDir,
      id: 'project-root',
    })

    // With agentsRoot set to the project dir, walk-up refuses to return a
    // marker inside it (prevents agent homes from being treated as projects).
    expect(findProjectMarker(subDir, { agentsRoot: projectDir })).toBeUndefined()
  })

  test('findProjectMarker treats local agent roots as non-crossable but still returns containing project root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-local-boundary-'))
    const projectDir = join(tmp, 'project-root')
    const localAgentsRoot = join(projectDir, 'agents')
    const agentSubdir = join(localAgentsRoot, 'bench', 'skills')
    mkdirSync(agentSubdir, { recursive: true })
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
    writeFileSync(join(localAgentsRoot, 'asp-targets.toml'), 'schema = 1\n')

    expect(
      findProjectMarker(agentSubdir, {
        agentRoots: [localAgentsRoot],
        projectRoot: projectDir,
      })
    ).toEqual({
      dir: projectDir,
      id: 'project-root',
    })
  })

  test('findProjectMarker stops at git repo root and does not cross into ancestors', () => {
    // Layout:
    //   tmp/
    //     outer/
    //       asp-targets.toml      <- marker that should NOT apply
    //       inner/
    //         .git/                <- git repo boundary
    //         src/
    // Walk-up from src should stop at inner (the git root) and NOT return
    // the outer marker. Instead it falls back to inner as implicit project.
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-git-'))
    const outer = join(tmp, 'outer')
    const inner = join(outer, 'inner')
    const src = join(inner, 'src')
    mkdirSync(src, { recursive: true })
    mkdirSync(join(inner, '.git'))
    writeFileSync(join(outer, 'asp-targets.toml'), 'schema = 1\n')

    expect(findProjectMarker(src)).toEqual({
      dir: inner,
      id: 'inner',
    })
  })

  test('findProjectMarker prefers explicit marker inside git repo over implicit git fallback', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-git2-'))
    const repo = join(tmp, 'repo')
    const src = join(repo, 'src')
    mkdirSync(src, { recursive: true })
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, 'asp-targets.toml'), 'schema = 1\n')

    expect(findProjectMarker(src)).toEqual({
      dir: repo,
      id: 'repo',
    })
  })

  test('findProjectMarker returns undefined outside a git repo when no marker exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-none-'))
    const dir = join(tmp, 'random')
    mkdirSync(dir, { recursive: true })

    // No marker on the walk-up path, no .git anywhere. Caller gets undefined
    // and can prompt, error, or fall back as appropriate.
    expect(findProjectMarker(dir)).toBeUndefined()
  })
})
