import { ancestorScopeRefs } from '../../index.js'
/**
 * RED tests for M1: agent-scope package — ScopeRef, LaneRef, SessionRef.
 *
 * These tests exercise the full agent-scope contract from AGENT_SPACES_PLAN.md
 * sections 1 (agent-scope contract) and the required APIs.
 *
 * wrkq tasks: T-00844 (scaffold), T-00845 (types/grammar), T-00846 (APIs), T-00847 (tests)
 *
 * PASS CONDITIONS:
 * 1. contracts/agent-scope exists as a Bun workspace package with zero workspace deps.
 * 2. Token grammar: [A-Za-z0-9._-]+ length 1..64 enforced by validateScopeRef/validateLaneRef.
 * 3. All valid ScopeRef forms parse and roundtrip correctly.
 * 4. All invalid ScopeRef forms are rejected with descriptive errors.
 * 5. LaneRef normalization: omitted/undefined -> "main", "lane:foo" -> "lane:foo".
 * 6. parseScopeRef, formatScopeRef, validateScopeRef, buildScopeRef, normalizeLaneRef and
 *    validateLaneRef behave per contract. SessionRef lives in session-ref.test.ts.
 */

import { describe, expect, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Import from the package that doesn't exist yet (RED)
// ---------------------------------------------------------------------------
import {
  buildScopeRef,
  formatScopeRef,
  normalizeLaneRef,
  parseScopeRef,
  validateLaneRef,
  validateScopeRef,
} from '../../index.js'
// ScopeKind is not part of the public barrel; read it from its defining module.
import type { ScopeKind } from '../types.js'

// ===================================================================
// Token grammar: [A-Za-z0-9._-]+ length 1..64
// ===================================================================
describe('token grammar (T-00845)', () => {
  const validTokens = [
    'alice',
    'bob-42',
    'my.agent',
    'under_score',
    'A',
    'a'.repeat(64),
    'Mix.Ed-Case_123',
    '0',
    '0.1.2',
  ]

  for (const token of validTokens) {
    test(`valid token: "${token}"`, () => {
      const ref = `agent:${token}`
      const result = validateScopeRef(ref)
      expect(result.ok).toBe(true)
    })
  }
})

// ===================================================================
// Valid ScopeRef forms
// ===================================================================
describe('valid ScopeRef forms (T-00845)', () => {
  const cases: Array<{
    input: string
    kind: ScopeKind
    agentId: string
    projectId?: string
    taskId?: string
    roleName?: string
  }> = [
    {
      input: 'agent:alice',
      kind: 'agent',
      agentId: 'alice',
    },
    {
      input: 'agent:alice:project:demo',
      kind: 'project',
      agentId: 'alice',
      projectId: 'demo',
    },
    {
      input: 'agent:alice:project:demo:role:tester',
      kind: 'project-role',
      agentId: 'alice',
      projectId: 'demo',
      roleName: 'tester',
    },
    {
      input: 'agent:alice:project:demo:task:t1',
      kind: 'project-task',
      agentId: 'alice',
      projectId: 'demo',
      taskId: 't1',
    },
    {
      input: 'agent:alice:project:demo:task:t1:role:tester',
      kind: 'project-task-role',
      agentId: 'alice',
      projectId: 'demo',
      taskId: 't1',
      roleName: 'tester',
    },
  ]

  for (const c of cases) {
    test(`parses "${c.input}" as kind=${c.kind}`, () => {
      const parsed = parseScopeRef(c.input)
      expect(parsed.kind).toBe(c.kind)
      expect(parsed.agentId).toBe(c.agentId)
      expect(parsed.projectId).toBe(c.projectId)
      expect(parsed.taskId).toBe(c.taskId)
      expect(parsed.roleName).toBe(c.roleName)
      expect(parsed.scopeRef).toBe(c.input)
    })

    test(`formatScopeRef reproduces every canonical ScopeRef kind it parsed: "${c.input}"`, () => {
      const parsed = parseScopeRef(c.input)
      const formatted = formatScopeRef(parsed)
      expect(formatted).toBe(c.input)
    })
  }
})

// ===================================================================
// Invalid ScopeRef forms
// ===================================================================
describe('invalid ScopeRef forms (T-00845)', () => {
  test('parseScopeRef on a ref without the agent prefix throws naming the input and the rule', () => {
    expect(() => parseScopeRef('project:demo')).toThrow(
      /^Invalid ScopeRef "project:demo": ScopeRef must start with "agent:<agentId>"$/
    )
  })
})

// ===================================================================
// LaneRef (T-00845)
// ===================================================================
describe('LaneRef normalization (T-00845)', () => {
  test('"lane:deploy" normalizes to "lane:deploy"', () => {
    expect(normalizeLaneRef('lane:deploy')).toBe('lane:deploy')
  })

  test('undefined normalizes to "main"', () => {
    expect(normalizeLaneRef(undefined)).toBe('main')
  })
})

describe('LaneRef validation (T-00845)', () => {
  test('validates "main"', () => {
    expect(validateLaneRef('main').ok).toBe(true)
  })

  test('validates "lane:deploy"', () => {
    expect(validateLaneRef('lane:deploy').ok).toBe(true)
  })

  test('rejects "lane:" (empty lane id)', () => {
    expect(validateLaneRef('lane:').ok).toBe(false)
  })

  test('rejects arbitrary string that is not main or lane:<id>', () => {
    expect(validateLaneRef('something-else').ok).toBe(false)
  })
})

// ===================================================================
// buildScopeRef / formatScopeRef — canonical assembly (backlog G)
// ===================================================================
describe('buildScopeRef (backlog G)', () => {
  test.each([
    { segments: { agentId: 'alice' }, expected: 'agent:alice' },
    { segments: { agentId: 'alice', projectId: 'demo' }, expected: 'agent:alice:project:demo' },
    {
      segments: { agentId: 'alice', projectId: 'demo', taskId: 't1' },
      expected: 'agent:alice:project:demo:task:t1',
    },
    {
      segments: { agentId: 'alice', projectId: 'demo', taskId: 't1', roleName: 'tester' },
      expected: 'agent:alice:project:demo:task:t1:role:tester',
    },
    {
      segments: { agentId: 'alice', projectId: 'demo', roleName: 'tester' },
      expected: 'agent:alice:project:demo:role:tester',
    },
  ])(
    'buildScopeRef appends each present segment in agent/project/task/role order: $expected',
    ({ segments, expected }) => {
      expect(buildScopeRef(segments)).toBe(expected)
    }
  )
})

// ===================================================================
// validateScopeRef — distinct error branches (backlog G)
// ===================================================================
describe('validateScopeRef error branches (backlog G)', () => {
  const branches: Array<{ input: string; match: RegExp }> = [
    { input: 'project:demo', match: /must start with "agent:<agentId>"/ },
    { input: '', match: /must start with "agent:<agentId>"/ },
    { input: 'agent:', match: /agentId must be 1\.\.64 characters/ },
    { input: 'agent::alice', match: /agentId must be 1\.\.64 characters/ },
    { input: `agent:${'a'.repeat(65)}`, match: /agentId must be 1\.\.64 characters/ },
    { input: 'agent:has space', match: /agentId contains invalid characters/ },
    { input: 'agent:emoji\u{1F600}', match: /agentId contains invalid characters/ },
    { input: 'agent:alice:task:t1', match: /expected "project:<projectId>"/ },
    { input: 'agent:alice:project:has space', match: /projectId contains invalid characters/ },
    {
      input: 'agent:alice:project:demo:role:r1:extra:x',
      match: /Expected exactly "role:<roleName>" after project segment/,
    },
    {
      input: 'agent:alice:project:demo:role:has space',
      match: /roleName contains invalid characters/,
    },
    {
      input: 'agent:alice:project:demo:task:has space',
      match: /taskId contains invalid characters/,
    },
    {
      input: 'agent:alice:project:demo:task:t1:notrole:x',
      match: /After "task:<taskId>", expected "role:<roleName>"/,
    },
    {
      input: 'agent:alice:project:demo:task:t1:role:has space',
      match: /roleName contains invalid characters/,
    },
    {
      input: 'agent:alice:project:demo:channel:general',
      match: /Unexpected segment "channel" after project/,
    },
  ]

  for (const { input, match } of branches) {
    test(`"${input}" → ${match}`, () => {
      const result = validateScopeRef(input)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(match)
      }
    })
  }
})

describe('published caller behavior (§9)', () => {
  /**
   * RED tests for M1: agent-scope package — ScopeRef, LaneRef, SessionRef.
   *
   * These tests exercise the full agent-scope contract from AGENT_SPACES_PLAN.md
   * sections 1 (agent-scope contract) and the required APIs.
   *
   * wrkq tasks: T-00844 (scaffold), T-00845 (types/grammar), T-00846 (APIs), T-00847 (tests)
   *
   * PASS CONDITIONS:
   * 1. contracts/agent-scope exists as a Bun workspace package with zero workspace deps.
   * 2. Token grammar: [A-Za-z0-9._-]+ length 1..64 enforced by validateScopeRef/validateLaneRef.
   * 3. All valid ScopeRef forms parse and roundtrip correctly.
   * 4. All invalid ScopeRef forms are rejected with descriptive errors.
   * 5. LaneRef normalization: omitted/undefined -> "main", "main" -> "main", "lane:foo" -> "lane:foo".
   * 6. parseScopeRef, formatScopeRef, validateScopeRef, normalizeLaneRef, validateLaneRef,
   *    normalizeSessionRef, ancestorScopeRefs all exist and behave per contract.
   * 7. ancestorScopeRefs returns least-specific to most-specific ancestry.
   */

  // ---------------------------------------------------------------------------
  // Import from the package that doesn't exist yet (RED)
  // ---------------------------------------------------------------------------

  // ===================================================================
  // ancestorScopeRefs (T-00846)
  // ===================================================================
  describe('ancestorScopeRefs (T-00846)', () => {
    test('agent:alice -> ["agent:alice"]', () => {
      expect(ancestorScopeRefs('agent:alice')).toEqual(['agent:alice'])
    })

    test('agent:alice:project:demo -> ["agent:alice", "agent:alice:project:demo"]', () => {
      expect(ancestorScopeRefs('agent:alice:project:demo')).toEqual([
        'agent:alice',
        'agent:alice:project:demo',
      ])
    })

    test('agent:alice:project:demo:role:tester -> 3 ancestors', () => {
      expect(ancestorScopeRefs('agent:alice:project:demo:role:tester')).toEqual([
        'agent:alice',
        'agent:alice:project:demo',
        'agent:alice:project:demo:role:tester',
      ])
    })

    test('agent:alice:project:demo:task:t1 -> 3 ancestors', () => {
      expect(ancestorScopeRefs('agent:alice:project:demo:task:t1')).toEqual([
        'agent:alice',
        'agent:alice:project:demo',
        'agent:alice:project:demo:task:t1',
      ])
    })

    test('agent:alice:project:demo:task:t1:role:tester -> 4 ancestors (from plan)', () => {
      expect(ancestorScopeRefs('agent:alice:project:demo:task:t1:role:tester')).toEqual([
        'agent:alice',
        'agent:alice:project:demo',
        'agent:alice:project:demo:task:t1',
        'agent:alice:project:demo:task:t1:role:tester',
      ])
    })

    test('returns least-specific to most-specific order', () => {
      const ancestors = ancestorScopeRefs('agent:alice:project:demo:task:t1')
      // First element is always the agent-only scope
      expect(ancestors[0]).toBe('agent:alice')
      // Last element is always the input itself
      expect(ancestors[ancestors.length - 1]).toBe('agent:alice:project:demo:task:t1')
    })
  })

  // ===================================================================
  // ancestorScopeRefs — project-role-without-task ordering (backlog G)
  // ===================================================================
  describe('ancestorScopeRefs project-role ordering (backlog G)', () => {
    test('project-role (no task) skips the task ancestor', () => {
      // The role ref is appended as the most-specific entry even though there is
      // no intervening task level.
      expect(ancestorScopeRefs('agent:alice:project:demo:role:reviewer')).toEqual([
        'agent:alice',
        'agent:alice:project:demo',
        'agent:alice:project:demo:role:reviewer',
      ])
    })
  })
})
