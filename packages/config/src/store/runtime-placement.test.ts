import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildRuntimeBundleRef,
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

  test('resolveAgentPlacementPaths infers roots and cwd from config roots', () => {
    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        projectId: 'agent-spaces',
        env: {
          ASP_AGENTS_ROOT: '/tmp/agents',
          ASP_PROJECTS_ROOT: '/tmp/projects',
        },
      })
    ).toEqual({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/projects/agent-spaces',
      cwd: '/tmp/projects/agent-spaces',
    })
  })

  test('resolveAgentPlacementPaths honors ASP_PROJECT_ROOT_OVERRIDE', () => {
    expect(
      resolveAgentPlacementPaths({
        agentId: 'larry',
        projectId: 'raw2draft',
        env: {
          ASP_AGENTS_ROOT: '/tmp/agents',
          ASP_PROJECTS_ROOT: '/tmp/projects',
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
          ASP_PROJECTS_ROOT: '/tmp/projects',
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
          ASP_PROJECTS_ROOT: '/tmp/projects',
          ASP_PROJECT_ROOT_OVERRIDE: '/opt/external/raw2draft',
        },
      })
    ).toEqual({
      agentRoot: '/tmp/agents/larry',
      cwd: '/tmp/agents/larry',
    })
  })

  test('inferProjectIdFromCwd prefers ASP_PROJECT and falls back to projects root layout', () => {
    expect(
      inferProjectIdFromCwd({
        env: {
          ASP_PROJECT: 'explicit-project',
          ASP_PROJECTS_ROOT: '/tmp/projects',
        },
        cwd: '/tmp/projects/ignored',
      })
    ).toBe('explicit-project')

    expect(
      inferProjectIdFromCwd({
        env: {
          ASP_PROJECTS_ROOT: '/tmp/projects',
        },
        cwd: '/tmp/projects/agent-spaces',
      })
    ).toBe('agent-spaces')
  })
})
