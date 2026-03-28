/**
 * RED tests for T-00893: ScopeHandle — bidirectional shorthand ↔ canonical ScopeRef.
 *
 * Tests the human-friendly shorthand grammar from AGENT_SCOPE_SHORTHAND.md:
 *   alice            → agent:alice
 *   alice@demo       → agent:alice:project:demo
 *   alice@demo:t1    → agent:alice:project:demo:task:t1
 *   alice@demo/reviewer → agent:alice:project:demo:role:reviewer
 *   alice@demo:t1/reviewer → agent:alice:project:demo:task:t1:role:reviewer
 *
 * PASS CONDITIONS:
 * 1. scope-handle.ts exports parseScopeHandle, formatScopeHandle, validateScopeHandle.
 * 2. parseScopeHandle converts shorthand → ParsedScopeRef with correct kind, fields, and scopeRef.
 * 3. formatScopeHandle converts ParsedScopeRef → shorthand string.
 * 4. Round-trip: formatScopeHandle(parseScopeHandle(h)) === h for all valid forms.
 * 5. validateScopeHandle returns { ok: true } for valid, { ok: false, error } for invalid.
 * 6. Invalid inputs throw/reject: empty string, missing agent, trailing delimiters, invalid chars.
 * 7. Tokens with dots/hyphens/underscores parse correctly.
 */

import { describe, expect, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Import from module that doesn't exist yet (RED)
// ---------------------------------------------------------------------------
import { formatScopeHandle, parseScopeHandle, validateScopeHandle } from '../scope-handle.js'

// ===================================================================
// parseScopeHandle
// ===================================================================
describe('parseScopeHandle (T-00893)', () => {
  const cases = [
    {
      handle: 'alice',
      expected: { kind: 'agent', agentId: 'alice', scopeRef: 'agent:alice' },
    },
    {
      handle: 'alice@demo',
      expected: {
        kind: 'project',
        agentId: 'alice',
        projectId: 'demo',
        scopeRef: 'agent:alice:project:demo',
      },
    },
    {
      handle: 'alice@demo:t1',
      expected: {
        kind: 'project-task',
        agentId: 'alice',
        projectId: 'demo',
        taskId: 't1',
        scopeRef: 'agent:alice:project:demo:task:t1',
      },
    },
    {
      handle: 'alice@demo/reviewer',
      expected: {
        kind: 'project-role',
        agentId: 'alice',
        projectId: 'demo',
        roleName: 'reviewer',
        scopeRef: 'agent:alice:project:demo:role:reviewer',
      },
    },
    {
      handle: 'alice@demo:t1/reviewer',
      expected: {
        kind: 'project-task-role',
        agentId: 'alice',
        projectId: 'demo',
        taskId: 't1',
        roleName: 'reviewer',
        scopeRef: 'agent:alice:project:demo:task:t1:role:reviewer',
      },
    },
  ] as const

  for (const c of cases) {
    test(`parses "${c.handle}" → kind=${c.expected.kind}`, () => {
      const parsed = parseScopeHandle(c.handle)
      expect(parsed.kind).toBe(c.expected.kind)
      expect(parsed.agentId).toBe(c.expected.agentId)
      expect(parsed.scopeRef).toBe(c.expected.scopeRef)

      if ('projectId' in c.expected) {
        expect(parsed.projectId).toBe(c.expected.projectId)
      }
      if ('taskId' in c.expected) {
        expect(parsed.taskId).toBe(c.expected.taskId)
      }
      if ('roleName' in c.expected) {
        expect(parsed.roleName).toBe(c.expected.roleName)
      }
    })
  }

  test('handles tokens with dots, hyphens, underscores', () => {
    const parsed = parseScopeHandle('my.agent@my-project:task_1/role.name')
    expect(parsed.kind).toBe('project-task-role')
    expect(parsed.agentId).toBe('my.agent')
    expect(parsed.projectId).toBe('my-project')
    expect(parsed.taskId).toBe('task_1')
    expect(parsed.roleName).toBe('role.name')
    expect(parsed.scopeRef).toBe('agent:my.agent:project:my-project:task:task_1:role:role.name')
  })
})

// ===================================================================
// parseScopeHandle — invalid inputs
// ===================================================================
describe('parseScopeHandle rejects invalid handles (T-00893)', () => {
  const invalidCases = [
    { handle: '', reason: 'empty string' },
    { handle: '@', reason: 'bare @' },
    { handle: '@demo', reason: 'missing agent (starts with @)' },
    { handle: ':t1', reason: 'missing agent (starts with :)' },
    { handle: '/role', reason: 'missing agent (starts with /)' },
    { handle: 'alice@', reason: 'trailing @ (empty project)' },
    { handle: 'alice@demo:', reason: 'trailing : (empty task)' },
    { handle: 'alice@demo/', reason: 'trailing / (empty role)' },
    { handle: 'alice@demo:t1!', reason: 'invalid character !' },
  ]

  for (const c of invalidCases) {
    test(`throws on "${c.handle}" (${c.reason})`, () => {
      expect(() => parseScopeHandle(c.handle)).toThrow()
    })
  }
})

// ===================================================================
// formatScopeHandle
// ===================================================================
describe('formatScopeHandle (T-00893)', () => {
  const cases = [
    {
      parsed: { kind: 'agent' as const, agentId: 'alice', scopeRef: 'agent:alice' },
      expected: 'alice',
    },
    {
      parsed: {
        kind: 'project' as const,
        agentId: 'alice',
        projectId: 'demo',
        scopeRef: 'agent:alice:project:demo',
      },
      expected: 'alice@demo',
    },
    {
      parsed: {
        kind: 'project-task' as const,
        agentId: 'alice',
        projectId: 'demo',
        taskId: 't1',
        scopeRef: 'agent:alice:project:demo:task:t1',
      },
      expected: 'alice@demo:t1',
    },
    {
      parsed: {
        kind: 'project-role' as const,
        agentId: 'alice',
        projectId: 'demo',
        roleName: 'reviewer',
        scopeRef: 'agent:alice:project:demo:role:reviewer',
      },
      expected: 'alice@demo/reviewer',
    },
    {
      parsed: {
        kind: 'project-task-role' as const,
        agentId: 'alice',
        projectId: 'demo',
        taskId: 't1',
        roleName: 'reviewer',
        scopeRef: 'agent:alice:project:demo:task:t1:role:reviewer',
      },
      expected: 'alice@demo:t1/reviewer',
    },
  ]

  for (const c of cases) {
    test(`formats kind=${c.parsed.kind} → "${c.expected}"`, () => {
      expect(formatScopeHandle(c.parsed)).toBe(c.expected)
    })
  }
})

// ===================================================================
// Round-trip: formatScopeHandle(parseScopeHandle(h)) === h
// ===================================================================
describe('ScopeHandle round-trip (T-00893)', () => {
  const handles = [
    'alice',
    'alice@demo',
    'alice@demo:t1',
    'alice@demo/reviewer',
    'alice@demo:t1/reviewer',
    'my.agent@my-project:task_1/role.name',
  ]

  for (const h of handles) {
    test(`round-trips "${h}"`, () => {
      expect(formatScopeHandle(parseScopeHandle(h))).toBe(h)
    })
  }
})

// ===================================================================
// validateScopeHandle
// ===================================================================
describe('validateScopeHandle (T-00893)', () => {
  const validHandles = [
    'alice',
    'alice@demo',
    'alice@demo:t1',
    'alice@demo/reviewer',
    'alice@demo:t1/reviewer',
    'my.agent@my-project:task_1/role.name',
  ]

  for (const h of validHandles) {
    test(`validates "${h}" as ok`, () => {
      const result = validateScopeHandle(h)
      expect(result.ok).toBe(true)
    })
  }

  const invalidHandles = [
    { handle: '', reason: 'empty' },
    { handle: '@', reason: 'bare @' },
    { handle: '@demo', reason: 'no agent' },
    { handle: 'alice@', reason: 'trailing @' },
    { handle: 'alice@demo:', reason: 'trailing :' },
    { handle: 'alice@demo/', reason: 'trailing /' },
    { handle: 'alice@demo:t1!', reason: 'invalid char' },
  ]

  for (const c of invalidHandles) {
    test(`rejects "${c.handle}" (${c.reason})`, () => {
      const result = validateScopeHandle(c.handle)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(typeof result.error).toBe('string')
        expect(result.error.length).toBeGreaterThan(0)
      }
    })
  }
})
