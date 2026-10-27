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
import { formatScopeHandle, parseScopeHandle } from '../scope-handle.js'

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
    {
      handle: 'my.agent@my-project:task_1/role.name',
      expected: {
        kind: 'project-task-role',
        agentId: 'my.agent',
        projectId: 'my-project',
        taskId: 'task_1',
        roleName: 'role.name',
        scopeRef: 'agent:my.agent:project:my-project:task:task_1:role:role.name',
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
})

// ===================================================================
// parseScopeHandle — invalid inputs
// ===================================================================
describe('parseScopeHandle rejects invalid handles (T-00893)', () => {
  const invalidCases = [
    {
      handle: '',
      reason: 'empty string',
      error: /^Invalid ScopeHandle "": ScopeHandle must not be empty$/,
    },
    { handle: '@', reason: 'bare @', error: /^Invalid ScopeHandle "@": agentId must be 1\.\.64/ },
    {
      handle: '@demo',
      reason: 'missing agent (starts with @)',
      error: /^Invalid ScopeHandle "@demo": agentId must be 1\.\.64/,
    },
    {
      handle: ':t1',
      reason: 'missing agent (starts with :)',
      error: /^Invalid ScopeHandle ":t1": agentId must be 1\.\.64/,
    },
    {
      handle: '/role',
      reason: 'missing agent (starts with /)',
      error: /^Invalid ScopeHandle "\/role": agentId contains invalid characters/,
    },
    {
      handle: 'alice@',
      reason: 'trailing @ (empty project)',
      error: /^Invalid ScopeHandle "alice@": projectId must be 1\.\.64/,
    },
    {
      handle: 'alice@demo:',
      reason: 'trailing : (empty task)',
      error: /^Invalid ScopeHandle "alice@demo:": taskId must be 1\.\.64/,
    },
    {
      handle: 'alice@demo/',
      reason: 'trailing / (empty role)',
      error: /^Invalid ScopeHandle "alice@demo\/": roleName must be 1\.\.64/,
    },
    {
      handle: 'alice@demo:t1!',
      reason: 'invalid character !',
      error: /^Invalid ScopeHandle "alice@demo:t1!": taskId contains invalid characters/,
    },
  ]

  for (const c of invalidCases) {
    test(`"${c.handle}" (${c.reason}) is rejected as a ScopeHandle naming the bad field`, () => {
      expect(() => parseScopeHandle(c.handle)).toThrow(c.error)
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
    test(`formatScopeHandle reproduces every handle kind that parseScopeHandle accepted: "${h}"`, () => {
      expect(formatScopeHandle(parseScopeHandle(h))).toBe(h)
    })
  }
})
