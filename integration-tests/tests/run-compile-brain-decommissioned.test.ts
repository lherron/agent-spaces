import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

describe('[brain] remains rejected at the v2 compiler boundary', () => {
  test('does not produce a canonical execution for an invalid agent profile', async () => {
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

  test('does not create an environment or dispatch request when profile parsing fails', async () => {
    const fixture = createV2CompileFixture('brainagent')
    fixtures.push(fixture)
    writeFileSync(
      join(fixture.agentRoot, 'agent-profile.toml'),
      'version = 4\n\n[spaces]\nbase = []\n\n[brain]\nenabled = true\n',
      'utf8'
    )
    const response = await compileV2(fixture, {
      namespace: 'brain-no-dispatch',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { EXTRA_FLAG: '1' },
    })
    expect(response.ok).toBe(false)
    expect(JSON.stringify(response)).not.toContain('EXTRA_FLAG')
    expect(JSON.stringify(response)).not.toContain('dispatchRequest')
  })
})
