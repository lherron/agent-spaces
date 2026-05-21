/**
 * Tests: buildBundleRef emission rules (T-00993, updated T-01564)
 *
 * After T-01564 the union is collapsed to {agent-project, compose}.
 * buildRuntimeBundleRef throws loudly when identity is incomplete.
 *
 * wrkq tasks: T-00993, T-01564
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildRuntimeBundleRef as buildBundleRef } from 'spaces-config'

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

  test('agentName without agentRoot → throws on missing agentRoot', () => {
    expect(() => buildBundleRef({ agentName: 'smokey' })).toThrow(
      /agentRoot is required when agentName is provided/
    )
  })

  test('agentName + agentRoot without profile → throws on missing profile', () => {
    const emptyRoot = join(tmpdir(), `asp-test-empty-${Date.now()}`)
    mkdirSync(emptyRoot, { recursive: true })
    try {
      expect(() => buildBundleRef({ agentName: 'smokey', agentRoot: emptyRoot })).toThrow(
        /agent-profile\.toml not found/
      )
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})

// ===================================================================
// T-00993 Phase 3.1: compose still takes precedence
// ===================================================================
describe('buildBundleRef: compose takes precedence over agentName (T-00993)', () => {
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
// T-01564: loud errors when identity is incomplete
// ===================================================================
describe('buildBundleRef: loud errors (T-01564)', () => {
  test('no agentName and no selectors → throws', () => {
    expect(() => buildBundleRef({})).toThrow(
      /no identifying selector provided/
    )
  })

  test('empty agentName treated as absent → throws', () => {
    expect(() => buildBundleRef({ agentName: '', agentRoot: testAgentRoot })).toThrow(
      /no identifying selector provided/
    )
  })
})
