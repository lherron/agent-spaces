/**
 * spaces-lint - Warning detection for agent spaces.
 *
 * WHY: Provides lint rules to detect configuration issues, conflicts, and best practice violations.
 */

// Types
export type {
  LintWarning,
  LintContext,
  LintRule,
  SpaceLintData,
  WarningSeverity,
  WarningCode,
} from './types.js'

export { WARNING_CODES } from './types.js'

// Reporter
export type { OutputFormat, LintSummary } from './reporter.js'
export { formatWarnings, formatText, formatJson, summarize } from './reporter.js'

// Individual rules
export {
  checkCommandCollisions,
  checkAgentCommandNamespace,
  checkHookPaths,
  checkHooksConfig,
  checkPluginNameCollisions,
  checkHookScriptsExecutable,
  checkSkillMdFrontmatter,
  allRules,
} from './rules/index.js'

import { allRules } from './rules/index.js'
import type { LintContext, LintWarning } from './types.js'

/**
 * Options for linting.
 */
export interface LintOptions {
  /** Rules to run (defaults to all) */
  rules?: string[] | undefined
}

/**
 * Run all lint rules against a context.
 */
export async function lint(
  context: LintContext,
  _options: LintOptions = {}
): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const rule of allRules) {
    const ruleWarnings = await rule(context)
    warnings.push(...ruleWarnings)
  }

  // Sort by code for consistent output
  warnings.sort((a, b) => a.code.localeCompare(b.code))

  return warnings
}
