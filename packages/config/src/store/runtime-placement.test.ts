import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildRuntimeBundleRef,
  findProjectMarker,
  inferProjectIdFromCwd,
  resolveAgentPlacementPaths,
} from './runtime-placement.js'

describe('runtime placement helpers', () => {
  test('buildRuntimeBundleRef prefers explicit selectors and detects agent-project bundles', () => {
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

    expect(
      buildRuntimeBundleRef({
        agentTarget: 'reviewer',
        agentName: 'larry',
        agentRoot,
      })
    ).toEqual({ kind: 'agent-target', target: 'reviewer' })

    expect(
      buildRuntimeBundleRef({
        projectTarget: 'smokey',
        projectRoot: '/tmp/project',
      })
    ).toEqual({
      kind: 'project-target',
      projectRoot: '/tmp/project',
      target: 'smokey',
    })
  })

  test('resolveAgentPlacementPaths finds projectRoot via asp-targets.toml marker walk-up', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-'))
    const agentsRoot = join(tmp, 'agents')
    const projectDir = join(tmp, 'projects', 'agent-spaces')
    mkdirSync(projectDir, { recursive: true })
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
    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        projectId: 'raw2draft',
        env: {
          ASP_AGENTS_ROOT: '/tmp/agents',
          ASP_PROJECT_ROOT_OVERRIDE: '/opt/external/raw2draft',
        },
      })
    ).toEqual({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/opt/external/raw2draft',
      cwd: '/opt/external/raw2draft',
    })
  })

  test('resolveAgentPlacementPaths expands ~ in ASP_PROJECT_ROOT_OVERRIDE', () => {
    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        projectId: 'raw2draft',
        env: {
          ASP_AGENTS_ROOT: '/tmp/agents',
          ASP_PROJECT_ROOT_OVERRIDE: '~/tools/raw2draft',
        },
      })
    ).toEqual({
      agentRoot: '/tmp/agents/larry',
      projectRoot: join(homedir(), 'tools/raw2draft'),
      cwd: join(homedir(), 'tools/raw2draft'),
    })
  })

  test('resolveAgentPlacementPaths ignores ASP_PROJECT_ROOT_OVERRIDE when projectId is absent', () => {
    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        env: {
          ASP_AGENTS_ROOT: '/tmp/agents',
          ASP_PROJECT_ROOT_OVERRIDE: '/opt/external/raw2draft',
        },
      })
    ).toEqual({
      agentRoot: '/tmp/agents/larry',
      cwd: '/tmp/agents/larry',
    })
  })

  test('inferProjectIdFromCwd prefers ASP_PROJECT and falls back to marker walk-up', () => {
    expect(
      inferProjectIdFromCwd({
        env: {
          ASP_PROJECT: 'explicit-project',
        },
        cwd: '/tmp',
      })
    ).toBe('explicit-project')

    const tmp = mkdtempSync(join(tmpdir(), 'runtime-placement-marker-'))
    const projectDir = join(tmp, 'agent-spaces')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'asp-targets.toml'), 'schema = 1\n')

    expect(
      inferProjectIdFromCwd({
        env: {},
        cwd: projectDir,
      })
    ).toBe('agent-spaces')
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
