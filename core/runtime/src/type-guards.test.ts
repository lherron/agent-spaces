import { describe, expect, test } from 'bun:test'
import { isRecord } from './type-guards.js'

describe('isRecord', () => {
  test('accepts plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  test('rejects null', () => {
    expect(isRecord(null)).toBe(false)
  })

  test('rejects arrays', () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord([1, 2, 3])).toBe(false)
  })

  test('rejects primitives and undefined', () => {
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord('string')).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(true)).toBe(false)
  })
})
