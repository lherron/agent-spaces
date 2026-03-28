/**
 * RED tests for T-00893: SessionHandle — shorthand with lane suffix.
 *
 * SessionHandle extends ScopeHandle with an optional ~lane suffix:
 *   alice@demo:t1~repair     → scopeRef: agent:alice:project:demo:task:t1, laneRef: lane:repair
 *   alice@demo~main          → scopeRef: agent:alice:project:demo, laneRef: main
 *   alice                    → scopeRef: agent:alice, laneRef: main (default)
 *   alice@demo:t1/reviewer~fix → scopeRef: agent:alice:project:demo:task:t1:role:reviewer, laneRef: lane:fix
 *
 * PASS CONDITIONS:
 * 1. session-handle.ts exports parseSessionHandle and formatSessionHandle.
 * 2. parseSessionHandle splits handle at ~ into scope portion + lane, returns SessionRef.
 * 3. Lane defaults to 'main' when ~ is absent.
 * 4. formatSessionHandle omits ~main suffix (canonical elision).
 * 5. Round-trip: formatSessionHandle(parseSessionHandle(h)) === h for all valid forms.
 * 6. Invalid scope portions still throw.
 */

import { describe, expect, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Import from module that doesn't exist yet (RED)
// ---------------------------------------------------------------------------
import { formatSessionHandle, parseSessionHandle } from '../session-handle.js'

// ===================================================================
// parseSessionHandle
// ===================================================================
describe('parseSessionHandle (T-00893)', () => {
  test('alice@demo:t1~repair → scopeRef + lane:repair', () => {
    const result = parseSessionHandle('alice@demo:t1~repair')
    expect(result.scopeRef).toBe('agent:alice:project:demo:task:t1')
    expect(result.laneRef).toBe('lane:repair')
  })

  test('alice@demo~main → scopeRef + main lane', () => {
    const result = parseSessionHandle('alice@demo~main')
    expect(result.scopeRef).toBe('agent:alice:project:demo')
    expect(result.laneRef).toBe('main')
  })

  test('alice (no lane) → scopeRef + default main lane', () => {
    const result = parseSessionHandle('alice')
    expect(result.scopeRef).toBe('agent:alice')
    expect(result.laneRef).toBe('main')
  })

  test('alice@demo:t1/reviewer~fix → full scope + lane:fix', () => {
    const result = parseSessionHandle('alice@demo:t1/reviewer~fix')
    expect(result.scopeRef).toBe('agent:alice:project:demo:task:t1:role:reviewer')
    expect(result.laneRef).toBe('lane:fix')
  })

  test('alice@demo → scopeRef + default main lane', () => {
    const result = parseSessionHandle('alice@demo')
    expect(result.scopeRef).toBe('agent:alice:project:demo')
    expect(result.laneRef).toBe('main')
  })

  test('alice@demo/reviewer~deploy → project-role + lane:deploy', () => {
    const result = parseSessionHandle('alice@demo/reviewer~deploy')
    expect(result.scopeRef).toBe('agent:alice:project:demo:role:reviewer')
    expect(result.laneRef).toBe('lane:deploy')
  })
})

// ===================================================================
// parseSessionHandle — invalid inputs
// ===================================================================
describe('parseSessionHandle rejects invalid handles (T-00893)', () => {
  const invalidCases = [
    { handle: '', reason: 'empty string' },
    { handle: '@demo~lane', reason: 'missing agent' },
    { handle: 'alice@~lane', reason: 'empty project' },
    { handle: '~lane', reason: 'no scope, just lane' },
  ]

  for (const c of invalidCases) {
    test(`throws on "${c.handle}" (${c.reason})`, () => {
      expect(() => parseSessionHandle(c.handle)).toThrow()
    })
  }
})

// ===================================================================
// formatSessionHandle
// ===================================================================
describe('formatSessionHandle (T-00893)', () => {
  test('formats scopeRef + lane:repair → alice@demo:t1~repair', () => {
    const result = formatSessionHandle({
      scopeRef: 'agent:alice:project:demo:task:t1',
      laneRef: 'lane:repair',
    })
    expect(result).toBe('alice@demo:t1~repair')
  })

  test('elides ~main suffix for main lane', () => {
    const result = formatSessionHandle({
      scopeRef: 'agent:alice:project:demo',
      laneRef: 'main',
    })
    expect(result).toBe('alice@demo')
  })

  test('formats agent-only with non-main lane', () => {
    const result = formatSessionHandle({
      scopeRef: 'agent:alice',
      laneRef: 'lane:debug',
    })
    expect(result).toBe('alice~debug')
  })

  test('formats full task-role with lane', () => {
    const result = formatSessionHandle({
      scopeRef: 'agent:alice:project:demo:task:t1:role:reviewer',
      laneRef: 'lane:fix',
    })
    expect(result).toBe('alice@demo:t1/reviewer~fix')
  })
})

// ===================================================================
// Round-trip: formatSessionHandle(parseSessionHandle(h)) === h
// ===================================================================
describe('SessionHandle round-trip (T-00893)', () => {
  const handles = [
    'alice',
    'alice@demo',
    'alice@demo:t1',
    'alice@demo:t1~repair',
    'alice@demo/reviewer',
    'alice@demo:t1/reviewer~fix',
    'alice~debug',
  ]

  for (const h of handles) {
    test(`round-trips "${h}"`, () => {
      expect(formatSessionHandle(parseSessionHandle(h))).toBe(h)
    })
  }
})
