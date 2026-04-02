/**
 * RED tests: Phase 3 — buildBundleRef emits agent-project bundle (T-00993)
 *
 * WHY: When no explicit bundle selection flags (--agent-target, --project-target,
 * --compose) are provided, but agentName IS available AND agent-profile.toml
 * exists at agentRoot, buildBundleRef should emit
 * { kind: 'agent-project', agentName, projectRoot } instead of { kind: 'agent-default' }.
 * This enables the placement resolver to use agent-profile.toml + project overrides.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. BundleRefOptions interface includes optional agentName and agentRoot fields
 * 2. buildBundleRef with agentName + agentRoot (with agent-profile.toml) returns agent-project
 * 3. buildBundleRef with agentName but no agentRoot falls back to agent-default
 * 4. Explicit selectors still take precedence over agentName
 * 5. No agentName and no selectors → kind: 'agent-default' (backward compat)
 *
 * wrkq task: T-00993
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildBundleRef } from '../shared.js'

// Create a temp agent root with agent-profile.toml for tests
const testAgentRoot = join(tmpdir(), `asp-test-agent-root-${Date.now()}`)

beforeAll(() => {
  mkdirSync(testAgentRoot, { recursive: true })
  writeFileSync(
    join(testAgentRoot, 'agent-profile.toml'),
    'schemaVersion = 2\n\n[identity]\ndisplay = "Test"\n'
  )
})

afterAll(() => {
  rmSync(testAgentRoot, { recursive: true, force: true })
})

// ===================================================================
// T-00993 Phase 3.1: buildBundleRef emits agent-project
// ===================================================================
describe('buildBundleRef: agent-project emission (T-00993)', () => {
  test('agentName + agentRoot with profile → kind: agent-project', () => {
    const result = buildBundleRef({ agentName: 'larry', agentRoot: testAgentRoot })
    expect(result.kind).toBe('agent-project')
    expect((result as any).agentName).toBe('larry')
  })

  test('agentName + agentRoot + projectRoot → kind: agent-project with projectRoot', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      agentRoot: testAgentRoot,
      projectRoot: '/srv/projects/myproject',
    })
    expect(result.kind).toBe('agent-project')
    expect((result as any).agentName).toBe('larry')
    expect((result as any).projectRoot).toBe('/srv/projects/myproject')
  })

  test('agentName without agentRoot → agent-default (no profile to check)', () => {
    const result = buildBundleRef({ agentName: 'smokey' } as any)
    expect(result.kind).toBe('agent-default')
  })

  test('agentName + agentRoot without profile → agent-default', () => {
    const emptyRoot = join(tmpdir(), `asp-test-empty-${Date.now()}`)
    mkdirSync(emptyRoot, { recursive: true })
    try {
      const result = buildBundleRef({ agentName: 'smokey', agentRoot: emptyRoot })
      expect(result.kind).toBe('agent-default')
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})

// ===================================================================
// T-00993 Phase 3.1: explicit selectors still take precedence
// ===================================================================
describe('buildBundleRef: explicit selectors override agentName (T-00993)', () => {
  test('agentTarget takes precedence over agentName', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      agentRoot: testAgentRoot,
      agentTarget: 'review',
    })
    expect(result.kind).toBe('agent-target')
  })

  test('projectTarget takes precedence over agentName', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      agentRoot: testAgentRoot,
      projectTarget: 'dev',
      projectRoot: '/p',
    })
    expect(result.kind).toBe('project-target')
  })

  test('compose takes precedence over agentName', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      agentRoot: testAgentRoot,
      compose: ['space:my-space@dev'],
    })
    expect(result.kind).toBe('compose')
  })
})

// ===================================================================
// T-00993 Phase 3.1: backward compatibility
// ===================================================================
describe('buildBundleRef: backward compat (T-00993)', () => {
  test('no agentName and no selectors → agent-default', () => {
    const result = buildBundleRef({})
    expect(result.kind).toBe('agent-default')
  })

  test('empty agentName treated as absent → agent-default', () => {
    const result = buildBundleRef({ agentName: '', agentRoot: testAgentRoot })
    // Empty string agentName should fall through to agent-default
    expect(result.kind).toBe('agent-default')
  })
})
