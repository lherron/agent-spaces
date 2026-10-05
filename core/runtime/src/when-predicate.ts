import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextResolverContext } from './context-resolver.js'
import type { ContextSection } from './context-template.js'
import { derivePromptTaskFacts } from './task-prompt-facts.js'

/**
 * Evaluate a section's optional `when` predicate. A section is included only if
 * ALL declared conditions hold (runMode match, path existence, and env
 * set/equals/not-equals checks). A section without a predicate always matches.
 */
export function matchesWhenPredicate(
  section: Pick<ContextSection, 'when'>,
  context: ContextResolverContext
): boolean {
  const when = section.when
  if (when === undefined) {
    return true
  }

  if (when.runMode !== undefined && when.runMode !== context.runMode) {
    return false
  }

  if (
    when.exists !== undefined &&
    !existsSync(join(context.predicateCwd ?? context.cwd ?? process.cwd(), when.exists))
  ) {
    return false
  }

  if (when.taskField !== undefined) {
    const facts = derivePromptTaskFacts(context)
    if (facts === undefined || facts[when.taskField] === undefined) {
      return false
    }
  }

  const env = context.predicateEnv ?? context.env ?? process.env

  if (when.envSet !== undefined) {
    const value = env[when.envSet]
    if (typeof value !== 'string' || value.trim().length === 0) {
      return false
    }
  }

  if (when.envEquals !== undefined) {
    const value = env[when.envEquals.name]
    if (value !== when.envEquals.value) {
      return false
    }
  }

  if (when.envNotEquals !== undefined) {
    const value = env[when.envNotEquals.name]
    if (value === when.envNotEquals.value) {
      return false
    }
  }

  return true
}
