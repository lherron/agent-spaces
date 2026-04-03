/**
 * Red/green ownership for wrkq T-01017.
 *
 * Step 5 finishes the canonical runtime naming cleanup from T-01016 by
 * removing the materializeSystemPromptV2 alias. This test should fail until
 * the alias is gone from the runtime entrypoint.
 */

import { describe, expect, test } from 'bun:test'

describe('T-01017 runtime cleanup', () => {
  test('runtime entrypoint only exposes the canonical materializeSystemPrompt helper', async () => {
    const runtimeModule = (await import('./index.js')) as Record<string, unknown>

    expect(typeof runtimeModule.materializeSystemPrompt).toBe('function')
    expect(runtimeModule.materializeSystemPromptV2).toBeUndefined()
  })
})
