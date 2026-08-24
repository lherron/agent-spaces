/**
 * W400 (U1 / BP-64): skill `name` must equal its directory basename and be kebab-case.
 *
 * WHY: Mismatched or non-kebab names break discovery and the name==basename invariant
 * every corpus skill holds. Fully mechanical (rubric §2 M2).
 */

import { basename } from 'node:path'
import type { LintWarning } from '../../types.js'
import type { HygieneContext } from '../types.js'
import { HYGIENE_CODES } from '../types.js'

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function checkNameMatchesDir(ctx: HygieneContext): LintWarning[] {
  const warnings: LintWarning[] = []
  for (const unit of ctx.units) {
    if (unit.kind !== 'skill') {
      continue
    }
    const dirName = basename(unit.dir)
    const name = unit.frontmatter?.name
    if (name === undefined) {
      // Missing name is covered by E208; skip here to avoid double-reporting.
      continue
    }
    if (name !== dirName) {
      warnings.push({
        code: HYGIENE_CODES.NAME_DIRNAME,
        message: `Skill name '${name}' does not match directory basename '${dirName}'. Rename the field or the directory so they match.`,
        severity: 'warning',
        path: unit.path,
        details: { unit: unit.key, name, dirName },
      })
      continue
    }
    if (!KEBAB.test(name)) {
      warnings.push({
        code: HYGIENE_CODES.NAME_DIRNAME,
        message: `Skill name '${name}' is not kebab-case (lowercase, hyphen-separated).`,
        severity: 'warning',
        path: unit.path,
        details: { unit: unit.key, name },
      })
    }
  }
  return warnings
}
