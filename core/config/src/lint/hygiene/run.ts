/**
 * Tier-1 hygiene lint runner: scan a target, run every W4xx rule, apply the
 * baseline, and report.
 */

import type { LintWarning } from '../types.js'
import { applyBaseline, loadBaseline } from './baseline.js'
import { allHygieneRules } from './rules/index.js'
import { scanHygieneTarget } from './scan.js'
import type { HygieneContext } from './types.js'

export interface HygieneRunOptions {
  /** Path to a baseline file; findings whose fingerprint matches are suppressed. */
  baselinePath?: string | undefined
  /** Root used to compute portable relative paths in fingerprints. */
  baselineRoot?: string | undefined
}

export interface HygieneRunResult {
  context: HygieneContext
  /** Findings NOT suppressed by the baseline, sorted by code then path. */
  warnings: LintWarning[]
  /** Findings suppressed by the baseline. */
  suppressed: LintWarning[]
}

/** Run every hygiene rule over a context. */
export async function lintHygiene(context: HygieneContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []
  for (const rule of allHygieneRules) {
    warnings.push(...(await rule(context)))
  }
  warnings.sort(
    (a, b) => a.code.localeCompare(b.code) || (a.path ?? '').localeCompare(b.path ?? '')
  )
  return warnings
}

/** Scan a filesystem target and run the tier-1 hygiene lint over it. */
export async function runHygieneTarget(
  target: string,
  options: HygieneRunOptions = {}
): Promise<HygieneRunResult> {
  const context = await scanHygieneTarget(target)
  const all = await lintHygiene(context)

  if (options.baselinePath) {
    const baseline = await loadBaseline(options.baselinePath)
    const { kept, suppressed } = applyBaseline(all, baseline, options.baselineRoot)
    return { context, warnings: kept, suppressed }
  }
  return { context, warnings: all, suppressed: [] }
}

/** True if any warning is a hard error (fails --strict). */
export function hasStrictFailure(warnings: LintWarning[]): boolean {
  return warnings.some((w) => w.severity === 'error')
}
