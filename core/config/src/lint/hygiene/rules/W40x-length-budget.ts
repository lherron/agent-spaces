/**
 * W401 / W402 (U11 / BP-17 / CF-3): length within the regime's budget.
 *
 * WHY: Load regime governs which length proxy is valid (CF-3):
 *  - model-invoked skill `description` is always-resident → hard ~500-char ceiling
 *    (W401). Candidate over ~350 chars.
 *  - resident prompt body pays per-turn rent → word budget (W402). On-demand skill
 *    bodies are relevance-only: NO word cap (flagging TDD's 1496 words is a false
 *    positive), only the universal ~500-line backstop applies.
 *
 * Thresholds are exposed so callers/tests can tune them.
 */

import type { LintWarning } from '../../types.js'
import { lineCount, stripFrontmatter, wordCount } from '../parse.js'
import type { HygieneContext } from '../types.js'
import { HYGIENE_CODES } from '../types.js'

export interface LengthBudget {
  /** Model-invoked description hard ceiling (chars). */
  descriptionCeiling: number
  /** Model-invoked description candidate threshold (chars). */
  descriptionCandidate: number
  /** Resident prompt body word budget. */
  residentWordBudget: number
  /** Universal line backstop for any body. */
  lineBackstop: number
}

export const DEFAULT_LENGTH_BUDGET: LengthBudget = {
  descriptionCeiling: 500,
  descriptionCandidate: 350,
  residentWordBudget: 400,
  lineBackstop: 500,
}

export function checkLengthBudget(
  ctx: HygieneContext,
  budget: LengthBudget = DEFAULT_LENGTH_BUDGET
): LintWarning[] {
  const warnings: LintWarning[] = []

  for (const unit of ctx.units) {
    const body = unit.kind === 'skill' ? stripFrontmatter(unit.content) : unit.content
    const words = wordCount(body)
    const lines = lineCount(unit.content)

    // W401 — description ceiling (skills, model-invoked only).
    if (unit.kind === 'skill' && unit.frontmatter?.disableModelInvocation !== true) {
      const desc = unit.frontmatter?.description
      if (desc !== undefined) {
        const chars = desc.length
        if (chars > budget.descriptionCeiling) {
          warnings.push({
            code: HYGIENE_CODES.DESCRIPTION_BUDGET,
            message: `Description is ${chars} chars, over the ~${budget.descriptionCeiling}-char resident ceiling. Trim to a when/why trigger; move process into the body.`,
            severity: 'warning',
            path: unit.path,
            details: { unit: unit.key, chars, ceiling: budget.descriptionCeiling },
          })
        } else if (chars > budget.descriptionCandidate) {
          warnings.push({
            code: HYGIENE_CODES.DESCRIPTION_BUDGET,
            message: `Description is ${chars} chars (candidate: over ~${budget.descriptionCandidate}). Verify it is not restating the body (see U5/U6).`,
            severity: 'info',
            path: unit.path,
            details: { unit: unit.key, chars, candidate: budget.descriptionCandidate },
          })
        }
      }
    }

    // W402 — resident body word budget.
    if (unit.regime === 'resident' && words > budget.residentWordBudget) {
      warnings.push({
        code: HYGIENE_CODES.BODY_BUDGET,
        message: `Resident body is ${words} words, over the ~${budget.residentWordBudget}-word budget. Every line is per-turn rent; push occasional reference to an on-demand file with a routing pointer.`,
        severity: 'warning',
        path: unit.path,
        details: { unit: unit.key, words, budget: budget.residentWordBudget, regime: unit.regime },
      })
    }

    // W402 — universal line backstop (any regime).
    if (lines > budget.lineBackstop) {
      warnings.push({
        code: HYGIENE_CODES.BODY_BUDGET,
        message: `Body is ${lines} lines, over the ~${budget.lineBackstop}-line backstop. Disclose reference behind pointers or split by branch/sequence.`,
        severity: 'info',
        path: unit.path,
        details: { unit: unit.key, lines, backstop: budget.lineBackstop, regime: unit.regime },
      })
    }
  }

  return warnings
}
