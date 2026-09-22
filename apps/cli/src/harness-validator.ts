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

import { DEFAULT_HARNESS_ID, catalogHarnessIds } from 'agent-spaces'
import type { HarnessId } from 'spaces-runtime-contracts'

export { DEFAULT_HARNESS_ID }

function isPublicHarnessId(harness: string): harness is HarnessId {
  return catalogHarnessIds().includes(harness)
}

/**
 * Print the standard "unknown harness" error block and exit.
 */
function exitWithUnknownHarness(harnessId: string): never {
  console.error(chalk.red(`Error: Unknown harness "${harnessId}"`))
  console.error(chalk.gray(''))
  console.error(chalk.gray('Available harnesses:'))
  for (const id of catalogHarnessIds()) {
    console.error(chalk.gray(`  - ${id}`))
  }
  process.exit(1)
}

/**
 * Validate a `--harness` option, defaulting to the catalog's agent-harness
 * entry when omitted.
 *
 * Exits with the standard error block if the harness id is unknown.
 */
export function validateHarness(harness: string | undefined): HarnessId {
  const harnessId = harness ?? DEFAULT_HARNESS_ID

  if (!isPublicHarnessId(harnessId)) {
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

  if (!isPublicHarnessId(harness)) {
    exitWithUnknownHarness(harness)
  }

  return harness
}
