/**
 * Red/green ownership for wrkq T-01017.
 *
 * Step 5 removes the deprecated resolveInstructionLayer API surface from the
 * public spaces-config entrypoints. Keep these assertions focused on the
 * cleanup contract so future sessions can distinguish intentional API removal
 * from unrelated resolver regressions.
 */

import { describe, expect, test } from 'bun:test'

describe('T-01017 config cleanup', () => {
  test('root spaces-config entrypoint no longer exports resolveInstructionLayer', async () => {
    const configModule = (await import('../index.js')) as Record<string, unknown>

    expect(configModule.resolveInstructionLayer).toBeUndefined()
  })

  test('resolver entrypoint no longer exports resolveInstructionLayer', async () => {
    const resolverModule = (await import('../resolver/index.js')) as Record<string, unknown>

    expect(resolverModule.resolveInstructionLayer).toBeUndefined()
  })
})
