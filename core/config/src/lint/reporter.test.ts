import { formatJson, summarize } from './reporter.js'
/**
 * Tests for reporter module.
 *
 * WHY: Reporter output formatting is used for user feedback.
 * These tests verify the text lines `asp describe` / `asp install` print.
 */

import { describe, expect, it } from 'bun:test'
import type { SpaceKey } from '../core/index.js'
import { formatWarnings } from './reporter.js'
import type { LintWarning } from './types.js'

function createWarning(overrides: Partial<LintWarning> = {}): LintWarning {
  return {
    code: 'W201',
    message: 'Test warning',
    severity: 'warning',
    ...overrides,
  }
}

describe('formatWarnings', () => {
  it.each<{ row: string; warnings: LintWarning[]; expected: string }>([
    { row: 'basic', warnings: [createWarning()], expected: '[W201] Test warning' },
    {
      row: 'with space key',
      warnings: [createWarning({ spaceKey: 'space-id@abc123' as SpaceKey })],
      expected: '[W201] (space-id@abc123) Test warning',
    },
    {
      row: 'with path',
      warnings: [createWarning({ path: '/path/to/file.txt' })],
      expected: '[W201] Test warning at /path/to/file.txt',
    },
    {
      row: 'two warnings',
      warnings: [createWarning({ code: 'W201' }), createWarning({ code: 'W202' })],
      expected: '[W201] Test warning\n[W202] Test warning',
    },
  ])(
    'lint warnings print as "[CODE] (spaceKey) message at path", one per line: $row',
    ({ warnings, expected }) => {
      expect(formatWarnings(warnings)).toBe(expected)
    }
  )
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for reporter module.
   *
   * WHY: Reporter output formatting is used for user feedback.
   * These tests verify correct formatting in different modes.
   */

  function createWarning(overrides: Partial<LintWarning> = {}): LintWarning {
    return {
      code: 'W201',
      message: 'Test warning',
      severity: 'warning',
      ...overrides,
    }
  }

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
})
