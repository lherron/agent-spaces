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
  test.each([
    {
      handle: 'alice@demo:t1~repair',
      scopeRef: 'agent:alice:project:demo:task:t1',
      laneRef: 'lane:repair',
    },
    { handle: 'alice@demo~main', scopeRef: 'agent:alice:project:demo', laneRef: 'main' },
    { handle: 'alice@demo', scopeRef: 'agent:alice:project:demo', laneRef: 'main' },
  ])(
    'a ~lane suffix becomes lane:<id> and an absent or ~main suffix is the main lane: $handle',
    ({ handle, scopeRef, laneRef }) => {
      expect(parseSessionHandle(handle)).toEqual({ scopeRef, laneRef })
    }
  )
})

// ===================================================================
// parseSessionHandle — invalid inputs
// ===================================================================
describe('parseSessionHandle rejects invalid handles (T-00893)', () => {
  // The message names the scope portion only (the ~lane suffix is split off first)
  // and the field that failed, so the session layer's split is observable.
  const invalidCases = [
    {
      handle: '',
      reason: 'empty string',
      error: /^Invalid ScopeHandle "": ScopeHandle must not be empty$/,
    },
    {
      handle: '@demo~lane',
      reason: 'missing agent',
      error: /^Invalid ScopeHandle "@demo": agentId must be 1\.\.64/,
    },
    {
      handle: 'alice@~lane',
      reason: 'empty project',
      error: /^Invalid ScopeHandle "alice@": projectId must be 1\.\.64/,
    },
    {
      handle: '~lane',
      reason: 'no scope, just lane',
      error: /^Invalid ScopeHandle "": ScopeHandle must not be empty$/,
    },
  ]

  for (const c of invalidCases) {
    test(`"${c.handle}" (${c.reason}) is rejected naming the scope portion and its bad field`, () => {
      expect(() => parseSessionHandle(c.handle)).toThrow(c.error)
    })
  }

  test.each(['alice~', 'alice~bad lane'])('rejects malformed lane in %s', (handle) => {
    expect(() => parseSessionHandle(handle)).toThrow(/Invalid LaneRef.*laneId/)
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
