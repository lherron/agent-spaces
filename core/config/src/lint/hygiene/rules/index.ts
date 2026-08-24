/**
 * All tier-1 hygiene rules (W4xx). See ../RULES.md for the ledger.
 */

import type { LintWarning } from '../../types.js'
import type { HygieneContext } from '../types.js'
import { checkLengthBudget } from './W40x-length-budget.js'
import { checkTripwires } from './W41x-tripwires.js'
import { checkReferenceGraph } from './W42x-reference-graph.js'
import { checkNameMatchesDir } from './W400-name-dirname.js'
import { checkDeadLayer } from './W430-dead-layer.js'

export { checkNameMatchesDir } from './W400-name-dirname.js'
export { checkLengthBudget, DEFAULT_LENGTH_BUDGET } from './W40x-length-budget.js'
export type { LengthBudget } from './W40x-length-budget.js'
export { checkTripwires } from './W41x-tripwires.js'
export { checkReferenceGraph } from './W42x-reference-graph.js'
export { checkDeadLayer } from './W430-dead-layer.js'

/** Every hygiene rule, in a stable execution order. */
export const allHygieneRules: Array<
  (ctx: HygieneContext) => LintWarning[] | Promise<LintWarning[]>
> = [checkNameMatchesDir, checkLengthBudget, checkTripwires, checkReferenceGraph, checkDeadLayer]
