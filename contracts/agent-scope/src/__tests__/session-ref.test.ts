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
    test.each([
      {
        input: '  agent:alice:project:demo/lane:main  ',
        expected: { scopeRef: 'agent:alice:project:demo', laneRef: 'main' },
      },
      {
        input: 'agent:alice:project:demo /lane:main',
        expected: { scopeRef: 'agent:alice:project:demo', laneRef: 'main' },
      },
      {
        input: 'agent:alice/lane: deploy ',
        expected: { scopeRef: 'agent:alice', laneRef: 'lane:deploy' },
      },
    ])(
      'parseSessionRef trims whitespace around the input, the scopeRef and the lane id: "$input"',
      ({ input, expected }) => {
        expect(parseSessionRef(input)).toEqual(expected)
      }
    )
  })

  describe('rejects malformed input', () => {
    const shape = /^Invalid SessionRef: expected "<scopeRef>\/lane:<laneRef>"$/
    const emptySegment = /^Invalid SessionRef: scopeRef and laneRef are required$/
    const invalid: Array<{ input: string; error: RegExp }> = [
      { input: '', error: shape },
      { input: 'agent:rex:project:agent-spaces', error: shape },
      { input: 'agent:rex:project:agent-spaces/main', error: shape },
      { input: '/lane:main', error: emptySegment },
      { input: 'agent:rex:project:agent-spaces/lane:', error: emptySegment },
      { input: 'agent:rex:project:agent-spaces/lane:main/extra', error: shape },
    ]
    for (const { input, error } of invalid) {
      test(`"${input}" is rejected naming the malformed SessionRef part`, () => {
        expect(() => parseSessionRef(input)).toThrow(error)
      })
    }
  })
})
