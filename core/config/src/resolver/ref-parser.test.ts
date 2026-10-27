/**
 * Tests for ref-parser module.
 *
 * WHY: Reference parsing is fundamental to resolution.
 * These tests verify parsing and key building work correctly.
 */

import { describe, expect, it } from 'bun:test'
import { type SpaceKey, parseAllRefs, parseSpaceKey } from './ref-parser.js'

describe('parseSpaceKey', () => {
  it('should parse key into id and commit', () => {
    const key = 'my-space@abc123def456' as SpaceKey
    const { id, commit } = parseSpaceKey(key)
    expect(String(id)).toBe('my-space')
    expect(commit).toBe('abc123def456')
  })
})

describe('parseAllRefs', () => {
  it('should parse multiple refs', () => {
    const refs = parseAllRefs(['space:a@stable', 'space:b@^1.0.0'])
    expect(refs.length).toBe(2)
    expect(String(refs[0]?.id)).toBe('a')
    expect(String(refs[1]?.id)).toBe('b')
  })
})
