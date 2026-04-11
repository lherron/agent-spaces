/**
 * Red/green ownership for wrkq T-01017 and T-01044.
 *
 * Step 5 finishes the canonical runtime naming cleanup from T-01016 by
 * removing the materializeSystemPromptV2 alias. This test should fail until
 * the alias is gone from the runtime entrypoint. T-01044 extends the runtime
 * surface with v2 context exports without allowing that cleanup to regress.
 */

import { describe, expect, test } from 'bun:test'

describe('T-01017 runtime cleanup', () => {
  test('runtime entrypoint keeps the canonical materializeSystemPrompt helper and v2 context exports without reviving the old alias', async () => {
    const runtimeModule = (await import('./index.js')) as Record<string, unknown>

    expect(typeof runtimeModule.materializeSystemPrompt).toBe('function')
    expect(typeof runtimeModule.parseContextTemplate).toBe('function')
    expect(typeof runtimeModule.resolveContextTemplate).toBe('function')
    expect(runtimeModule.materializeSystemPromptV2).toBeUndefined()
  })
})
