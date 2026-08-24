/**
 * Direct coverage for session-ref.ts: normalizeSessionRef, parseSessionRef,
 * formatSessionRef. Backlog item D (whitespace policy) and the D/G test-gap
 * note (no session-ref.test.ts existed).
 */

import { describe, expect, test } from 'bun:test'

import { formatSessionRef, normalizeSessionRef, parseSessionRef } from '../session-ref.js'

describe('normalizeSessionRef', () => {
  test('keeps a valid scopeRef and explicit lane', () => {
    expect(
      normalizeSessionRef({ scopeRef: 'agent:alice:project:demo', laneRef: 'lane:deploy' })
    ).toEqual({ scopeRef: 'agent:alice:project:demo', laneRef: 'lane:deploy' })
  })

  test('defaults an omitted lane to "main"', () => {
    expect(normalizeSessionRef({ scopeRef: 'agent:alice' })).toEqual({
      scopeRef: 'agent:alice',
      laneRef: 'main',
    })
  })

  test('throws on an invalid scopeRef', () => {
    expect(() => normalizeSessionRef({ scopeRef: 'not-a-scope-ref' })).toThrow(/Invalid ScopeRef/)
  })

  test('throws on an invalid laneRef', () => {
    expect(() =>
      normalizeSessionRef({ scopeRef: 'agent:alice', laneRef: 'lane:bad char' })
    ).toThrow(/Invalid LaneRef/)
  })
})

describe('parseSessionRef', () => {
  test('parses the main lane', () => {
    expect(parseSessionRef('agent:rex:project:agent-spaces/lane:main')).toEqual({
      scopeRef: 'agent:rex:project:agent-spaces',
      laneRef: 'main',
    })
  })

  test('parses a non-main lane', () => {
    expect(parseSessionRef('agent:rex:project:agent-spaces/lane:repair')).toEqual({
      scopeRef: 'agent:rex:project:agent-spaces',
      laneRef: 'lane:repair',
    })
  })

  test('round-trips through formatSessionRef for every scope kind', () => {
    const refs = [
      'agent:alice/lane:main',
      'agent:alice:project:demo/lane:main',
      'agent:alice:project:demo:role:tester/lane:deploy',
      'agent:alice:project:demo:task:t1/lane:main',
      'agent:alice:project:demo:task:t1:role:tester/lane:repair',
    ]
    for (const ref of refs) {
      expect(formatSessionRef(parseSessionRef(ref))).toBe(ref)
    }
  })

  describe('whitespace policy (backlog D — trim uniformly)', () => {
    test('tolerates surrounding whitespace on the whole input', () => {
      expect(parseSessionRef('  agent:alice:project:demo/lane:main  ')).toEqual({
        scopeRef: 'agent:alice:project:demo',
        laneRef: 'main',
      })
    })

    test('tolerates whitespace around the scopeRef segment', () => {
      expect(parseSessionRef('agent:alice:project:demo /lane:main')).toEqual({
        scopeRef: 'agent:alice:project:demo',
        laneRef: 'main',
      })
    })

    test('tolerates whitespace around the laneId segment', () => {
      expect(parseSessionRef('agent:alice/lane: deploy ')).toEqual({
        scopeRef: 'agent:alice',
        laneRef: 'lane:deploy',
      })
    })
  })

  describe('rejects malformed input', () => {
    const invalid = [
      '',
      'agent:rex:project:agent-spaces',
      'agent:rex:project:agent-spaces/main',
      '/lane:main',
      'agent:rex:project:agent-spaces/lane:',
      'agent:rex:project:agent-spaces/lane:main/extra',
    ]
    for (const input of invalid) {
      test(`rejects "${input}"`, () => {
        expect(() => parseSessionRef(input)).toThrow()
      })
    }
  })
})

describe('formatSessionRef', () => {
  test('serializes the main lane', () => {
    expect(formatSessionRef({ scopeRef: 'agent:alice', laneRef: 'main' })).toBe(
      'agent:alice/lane:main'
    )
  })

  test('serializes a non-main lane', () => {
    expect(formatSessionRef({ scopeRef: 'agent:alice:project:demo', laneRef: 'lane:deploy' })).toBe(
      'agent:alice:project:demo/lane:deploy'
    )
  })
})
