/**
 * RED tests for M1: agent-scope package — ScopeRef, LaneRef, SessionRef.
 *
 * These tests exercise the full agent-scope contract from AGENT_SPACES_PLAN.md
 * sections 1 (agent-scope contract) and the required APIs.
 *
 * wrkq tasks: T-00844 (scaffold), T-00845 (types/grammar), T-00846 (APIs), T-00847 (tests)
 *
 * PASS CONDITIONS:
 * 1. packages/agent-scope exists as a Bun workspace package with zero workspace deps.
 * 2. Token grammar: [A-Za-z0-9._-]+ length 1..64 enforced by validateScopeRef/validateLaneRef.
 * 3. All valid ScopeRef forms parse and roundtrip correctly.
 * 4. All invalid ScopeRef forms are rejected with descriptive errors.
 * 5. LaneRef normalization: omitted/undefined -> "main", "main" -> "main", "lane:foo" -> "lane:foo".
 * 6. parseScopeRef, formatScopeRef, validateScopeRef, normalizeLaneRef, validateLaneRef,
 *    normalizeSessionRef, ancestorScopeRefs all exist and behave per contract.
 * 7. ancestorScopeRefs returns least-specific to most-specific ancestry.
 */

import { describe, expect, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Import from the package that doesn't exist yet (RED)
// ---------------------------------------------------------------------------
import {
  type ScopeKind,
  ancestorScopeRefs,
  formatScopeRef,
  normalizeLaneRef,
  normalizeSessionRef,
  parseScopeRef,
  validateLaneRef,
  validateScopeRef,
} from '../../index.js'

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

  const invalidTokens = [
    '', // empty
    'a'.repeat(65), // too long
    'has space', // space
    'has/slash', // slash
    'has:colon', // colon (delimiter, not token)
    'has@at', // at sign
    'emoji\u{1F600}', // non-ASCII
  ]

  for (const token of validTokens) {
    test(`valid token: "${token}"`, () => {
      const ref = `agent:${token}`
      const result = validateScopeRef(ref)
      expect(result.ok).toBe(true)
    })
  }

  for (const token of invalidTokens) {
    test(`invalid token: "${token}"`, () => {
      const ref = `agent:${token}`
      const result = validateScopeRef(ref)
      expect(result.ok).toBe(false)
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

    test(`roundtrips "${c.input}" through format`, () => {
      const parsed = parseScopeRef(c.input)
      const formatted = formatScopeRef(parsed)
      expect(formatted).toBe(c.input)
    })

    test(`validates "${c.input}" as ok`, () => {
      const result = validateScopeRef(c.input)
      expect(result.ok).toBe(true)
    })
  }
})

// ===================================================================
// Invalid ScopeRef forms
// ===================================================================
describe('invalid ScopeRef forms (T-00845)', () => {
  const invalidRefs = [
    // project alone (no agent)
    { input: 'project:demo', reason: 'project without agent prefix' },
    // embedded sessionId
    { input: 'agent:alice:session:s1', reason: 'embedded sessionId' },
    // task without project
    { input: 'agent:alice:task:t1', reason: 'task without project' },
    // role without project
    { input: 'agent:alice:role:tester', reason: 'role without project' },
    // empty string
    { input: '', reason: 'empty string' },
    // random garbage
    { input: 'not-a-scope-ref', reason: 'missing agent: prefix' },
    // double colon
    { input: 'agent::alice', reason: 'double colon (empty token)' },
    // trailing colon
    { input: 'agent:alice:', reason: 'trailing colon' },
    // unknown segment
    { input: 'agent:alice:project:demo:channel:general', reason: 'unknown segment type' },
  ]

  for (const c of invalidRefs) {
    test(`rejects "${c.input}" (${c.reason})`, () => {
      const result = validateScopeRef(c.input)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(typeof result.error).toBe('string')
        expect(result.error.length).toBeGreaterThan(0)
      }
    })
  }

  test('parseScopeRef throws on invalid input', () => {
    expect(() => parseScopeRef('project:demo')).toThrow()
  })
})

// ===================================================================
// LaneRef (T-00845)
// ===================================================================
describe('LaneRef normalization (T-00845)', () => {
  test('"main" normalizes to "main"', () => {
    expect(normalizeLaneRef('main')).toBe('main')
  })

  test('"lane:deploy" normalizes to "lane:deploy"', () => {
    expect(normalizeLaneRef('lane:deploy')).toBe('lane:deploy')
  })

  test('undefined normalizes to "main"', () => {
    expect(normalizeLaneRef(undefined)).toBe('main')
  })

  test('omitted normalizes to "main"', () => {
    expect(normalizeLaneRef()).toBe('main')
  })
})

describe('LaneRef validation (T-00845)', () => {
  test('validates "main"', () => {
    expect(validateLaneRef('main').ok).toBe(true)
  })

  test('validates "lane:deploy"', () => {
    expect(validateLaneRef('lane:deploy').ok).toBe(true)
  })

  test('validates "lane:my-lane.1"', () => {
    expect(validateLaneRef('lane:my-lane.1').ok).toBe(true)
  })

  test('rejects empty string', () => {
    expect(validateLaneRef('').ok).toBe(false)
  })

  test('rejects "lane:" (empty lane id)', () => {
    expect(validateLaneRef('lane:').ok).toBe(false)
  })

  test('rejects arbitrary string that is not main or lane:<id>', () => {
    expect(validateLaneRef('something-else').ok).toBe(false)
  })
})

// ===================================================================
// normalizeSessionRef (T-00846)
// ===================================================================
describe('normalizeSessionRef (T-00846)', () => {
  test('normalizes with explicit lane', () => {
    const result = normalizeSessionRef({
      scopeRef: 'agent:alice:project:demo',
      laneRef: 'lane:deploy',
    })
    expect(result.scopeRef).toBe('agent:alice:project:demo')
    expect(result.laneRef).toBe('lane:deploy')
  })

  test('defaults lane to "main" when omitted', () => {
    const result = normalizeSessionRef({
      scopeRef: 'agent:alice',
    })
    expect(result.scopeRef).toBe('agent:alice')
    expect(result.laneRef).toBe('main')
  })
})

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
// Type-level checks (T-00845)
// ===================================================================
describe('type exports (T-00845)', () => {
  test('ScopeKind union is complete', () => {
    // Verify all five kinds are valid values at runtime
    const kinds: ScopeKind[] = [
      'agent',
      'project',
      'project-role',
      'project-task',
      'project-task-role',
    ]
    expect(kinds).toHaveLength(5)
  })

  test('ParsedScopeRef shape is correct', () => {
    const parsed = parseScopeRef('agent:alice:project:demo')
    // Verify the shape has all required fields
    expect(parsed).toHaveProperty('kind')
    expect(parsed).toHaveProperty('agentId')
    expect(parsed).toHaveProperty('scopeRef')
    // projectId is present for project-scoped refs
    expect(parsed).toHaveProperty('projectId')
  })
})
