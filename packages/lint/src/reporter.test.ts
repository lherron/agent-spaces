/**
 * Tests for reporter module.
 *
 * WHY: Reporter output formatting is used for user feedback.
 * These tests verify correct formatting in different modes.
 */

import { describe, expect, it } from 'bun:test'
import type { SpaceKey } from 'spaces-core'
import { formatJson, formatText, formatWarnings, summarize } from './reporter.js'
import type { LintWarning } from './types.js'

function createWarning(overrides: Partial<LintWarning> = {}): LintWarning {
  return {
    code: 'W201',
    message: 'Test warning',
    severity: 'warning',
    ...overrides,
  }
}

describe('formatText', () => {
  it('should return empty string for no warnings', () => {
    expect(formatText([])).toBe('')
  })

  it('should format basic warning', () => {
    const warnings = [createWarning()]
    const result = formatText(warnings)
    expect(result).toBe('[W201] Test warning')
  })

  it('should include space key when present', () => {
    const warnings = [createWarning({ spaceKey: 'space-id@abc123' as SpaceKey })]
    const result = formatText(warnings)
    expect(result).toBe('[W201] (space-id@abc123) Test warning')
  })

  it('should include path when present', () => {
    const warnings = [createWarning({ path: '/path/to/file.txt' })]
    const result = formatText(warnings)
    expect(result).toBe('[W201] Test warning at /path/to/file.txt')
  })

  it('should format multiple warnings on separate lines', () => {
    const warnings = [createWarning({ code: 'W201' }), createWarning({ code: 'W202' })]
    const result = formatText(warnings)
    expect(result).toContain('[W201]')
    expect(result).toContain('[W202]')
    expect(result.split('\n')).toHaveLength(2)
  })
})

describe('formatJson', () => {
  it('should return empty array for no warnings', () => {
    expect(formatJson([])).toBe('[]')
  })

  it('should format warnings as JSON', () => {
    const warnings = [createWarning()]
    const result = JSON.parse(formatJson(warnings))
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('W201')
  })
})

describe('formatWarnings', () => {
  it('should default to text format', () => {
    const warnings = [createWarning()]
    const result = formatWarnings(warnings)
    expect(result).toBe('[W201] Test warning')
  })

  it('should use json format when specified', () => {
    const warnings = [createWarning()]
    const result = formatWarnings(warnings, 'json')
    expect(() => JSON.parse(result)).not.toThrow()
  })
})

describe('summarize', () => {
  it('should return zero totals for no warnings', () => {
    const summary = summarize([])
    expect(summary.total).toBe(0)
    expect(Object.keys(summary.bySeverity)).toHaveLength(0)
    expect(Object.keys(summary.byCode)).toHaveLength(0)
  })

  it('should count warnings by severity', () => {
    const warnings = [
      createWarning({ severity: 'warning' }),
      createWarning({ severity: 'warning' }),
      createWarning({ severity: 'info' }),
    ]
    const summary = summarize(warnings)
    expect(summary.total).toBe(3)
    expect(summary.bySeverity['warning']).toBe(2)
    expect(summary.bySeverity['info']).toBe(1)
  })

  it('should count warnings by code', () => {
    const warnings = [
      createWarning({ code: 'W201' }),
      createWarning({ code: 'W201' }),
      createWarning({ code: 'W203' }),
    ]
    const summary = summarize(warnings)
    expect(summary.byCode['W201']).toBe(2)
    expect(summary.byCode['W203']).toBe(1)
  })
})
