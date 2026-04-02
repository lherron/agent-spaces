/**
 * RED tests: Phase 3 — buildBundleRef emits agent-project bundle (T-00993)
 *
 * WHY: When no explicit bundle selection flags (--agent-target, --project-target,
 * --compose) are provided, but agentName IS available, buildBundleRef should emit
 * { kind: 'agent-project', agentName, projectRoot } instead of { kind: 'agent-default' }.
 * This enables the placement resolver to use agent-profile.toml + project overrides.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. BundleRefOptions interface includes optional agentName field
 * 2. buildBundleRef({ agentName: 'larry' }) returns { kind: 'agent-project', agentName: 'larry' }
 * 3. buildBundleRef({ agentName: 'larry', projectRoot: '/p' }) includes projectRoot
 * 4. Explicit selectors still take precedence over agentName:
 *    - agentTarget set → kind: 'agent-target'
 *    - projectTarget set → kind: 'project-target'
 *    - compose set → kind: 'compose'
 * 5. No agentName and no selectors → kind: 'agent-default' (backward compat)
 *
 * wrkq task: T-00993
 */

import { describe, expect, test } from 'bun:test'

import { buildBundleRef } from '../shared.js'

// ===================================================================
// T-00993 Phase 3.1: buildBundleRef emits agent-project
// ===================================================================
describe('buildBundleRef: agent-project emission (T-00993)', () => {
  test('agentName only → kind: agent-project', () => {
    const result = buildBundleRef({ agentName: 'larry' } as any)
    expect(result.kind).toBe('agent-project')
    expect((result as any).agentName).toBe('larry')
  })

  test('agentName + projectRoot → kind: agent-project with projectRoot', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      projectRoot: '/srv/projects/myproject',
    } as any)
    expect(result.kind).toBe('agent-project')
    expect((result as any).agentName).toBe('larry')
    expect((result as any).projectRoot).toBe('/srv/projects/myproject')
  })

  test('agentName without projectRoot → agent-project, projectRoot undefined', () => {
    const result = buildBundleRef({ agentName: 'smokey' } as any)
    expect(result.kind).toBe('agent-project')
    expect((result as any).projectRoot).toBeUndefined()
  })
})

// ===================================================================
// T-00993 Phase 3.1: explicit selectors still take precedence
// ===================================================================
describe('buildBundleRef: explicit selectors override agentName (T-00993)', () => {
  test('agentTarget takes precedence over agentName', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      agentTarget: 'review',
    } as any)
    expect(result.kind).toBe('agent-target')
  })

  test('projectTarget takes precedence over agentName', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      projectTarget: 'dev',
      projectRoot: '/p',
    } as any)
    expect(result.kind).toBe('project-target')
  })

  test('compose takes precedence over agentName', () => {
    const result = buildBundleRef({
      agentName: 'larry',
      compose: ['space:my-space@dev'],
    } as any)
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
    const result = buildBundleRef({ agentName: '' } as any)
    // Empty string agentName should fall through to agent-default
    expect(result.kind).toBe('agent-default')
  })
})
