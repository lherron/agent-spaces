/**
 * Shared Pi SDK entry-point resolution.
 *
 * Both the adapter (`adapters/pi-sdk-adapter.ts`) and the standalone runner
 * (`pi-sdk/pi-sdk/runner.ts`) need to locate the Pi coding-agent entry point
 * under a given SDK root, trying the same ordered candidate list and returning
 * the first that exists (or null). This is the single implementation so both
 * sites stay in lock-step.
 */

import { constants, access } from 'node:fs/promises'
import { join } from 'node:path'

export const SDK_ENTRY_CANDIDATES = [
  'packages/coding-agent/dist/index.js',
  'packages/coding-agent/src/index.ts',
]

/** Resolve the first existing Pi SDK entry under `sdkRoot`, or null if none. */
export async function resolveSdkEntry(sdkRoot: string): Promise<string | null> {
  for (const candidate of SDK_ENTRY_CANDIDATES) {
    const entryPath = join(sdkRoot, candidate)
    try {
      await access(entryPath, constants.F_OK)
      return entryPath
    } catch {
      // Candidate does not exist; try the next one.
    }
  }
  return null
}
