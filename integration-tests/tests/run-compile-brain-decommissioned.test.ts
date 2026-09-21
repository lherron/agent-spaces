import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('[brain] remains rejected at the v2 compiler boundary', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('does not manufacture an execution for an invalid profile', async () => {
    const fixture = createV2CompileFixture('brainagent')
    fixtures.push(fixture)
    writeFileSync(
      join(fixture.agentRoot, 'agent-profile.toml'),
      'version = 4\n\n[spaces]\nbase = []\n\n[brain]\nenabled = true\n',
      'utf8'
    )
    const response = await compileV2(fixture, {
      namespace: 'brain-decommissioned',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
    })

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toMatch(
      /brain/i
    )
  })
})
