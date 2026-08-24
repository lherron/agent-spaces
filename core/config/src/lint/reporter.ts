/**
 * Lint reporter for formatting warnings.
 *
 * WHY: Provides consistent output formatting for lint warnings.
 */

import type { LintWarning } from './types.js'

/**
 * Reporter output format.
 */
export type OutputFormat = 'text' | 'json'

/**
 * Format warnings as text.
 */
export function formatText(warnings: LintWarning[]): string {
  if (warnings.length === 0) {
    return ''
  }

  const lines: string[] = []

  for (const warning of warnings) {
    const parts: string[] = [`[${warning.code}]`]

    if (warning.spaceKey) {
      parts.push(`(${warning.spaceKey})`)
    }

    parts.push(warning.message)

    if (warning.path) {
      parts.push(`at ${warning.path}`)
    }

    lines.push(parts.join(' '))
  }

  return lines.join('\n')
}

/**
 * Format warnings as JSON.
 */
export function formatJson(warnings: LintWarning[]): string {
  return JSON.stringify(warnings, null, 2)
}

/**
 * Format warnings in the specified format.
 */
export function formatWarnings(warnings: LintWarning[], format: OutputFormat = 'text'): string {
  switch (format) {
    case 'json':
      return formatJson(warnings)
    default:
      return formatText(warnings)
  }
}

/**
 * Lint result summary.
 */
export interface LintSummary {
  /** Total warnings */
  total: number
  /** Warnings by severity */
  bySeverity: Record<string, number>
  /** Warnings by code */
  byCode: Record<string, number>
}

/**
 * Summarize lint warnings.
 */
export function summarize(warnings: LintWarning[]): LintSummary {
  const bySeverity: Record<string, number> = {}
  const byCode: Record<string, number> = {}

  for (const warning of warnings) {
    bySeverity[warning.severity] = (bySeverity[warning.severity] ?? 0) + 1
    byCode[warning.code] = (byCode[warning.code] ?? 0) + 1
  }

  return {
    total: warnings.length,
    bySeverity,
    byCode,
  }
}
