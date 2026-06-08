/**
 * Shared harness-option validation for chalk-based commands.
 *
 * WHY: `asp build`, `asp explain`, and `asp run` each carried a byte-identical
 * validator that printed the same "Unknown harness" error block (via chalk) and
 * called process.exit(1). Centralizing it removes the duplication while
 * preserving the exact output and exit behavior.
 *
 * NOTE: `asp install` intentionally keeps its own validator because it renders
 * the error through the ui.ts presentation helpers rather than chalk.
 */

import chalk from 'chalk'

import { type HarnessId, harnessRegistry, isHarnessId } from 'spaces-execution'

/**
 * Print the standard "unknown harness" error block and exit.
 */
function exitWithUnknownHarness(harnessId: string): never {
  console.error(chalk.red(`Error: Unknown harness "${harnessId}"`))
  console.error(chalk.gray(''))
  console.error(chalk.gray('Available harnesses:'))
  for (const adapter of harnessRegistry.getAll()) {
    console.error(chalk.gray(`  - ${adapter.id}`))
  }
  process.exit(1)
}

/**
 * Validate a `--harness` option, defaulting to `'claude'` when omitted.
 *
 * Exits with the standard error block if the harness id is unknown.
 */
export function validateHarness(harness: string | undefined): HarnessId {
  const harnessId = harness ?? 'claude'

  if (!isHarnessId(harnessId)) {
    exitWithUnknownHarness(harnessId)
  }

  return harnessId
}

/**
 * Validate an optional `--harness` option, returning `undefined` when omitted
 * (so the execution layer can apply its own default).
 *
 * Exits with the standard error block if a provided harness id is unknown.
 */
export function validateOptionalHarness(harness: string | undefined): HarnessId | undefined {
  if (harness === undefined) {
    return undefined
  }

  if (!isHarnessId(harness)) {
    exitWithUnknownHarness(harness)
  }

  return harness
}
