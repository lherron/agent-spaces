import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function execution(options: Parameters<typeof compileV2>[1]) {
  const fixture = createV2CompileFixture('smokey')
  fixtures.push(fixture)
  const response = await compileV2(fixture, options)
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  return response.plan.execution
}

describe('pre-HRC interactive tmux preparation on v2 plans', () => {
  test('materializes interactive Claude priming on its broker-owned launch specification', async () => {
    const result = await execution({
      namespace: 'interactive-claude-input',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      prompt: 'start the terminal turn through the broker',
    })
    const start = result.dispatchRequest.startRequest
    expect(start.initialInput).toBeUndefined()
    expect(start.spec.launch).toMatchObject({
      initialPrompt: 'start the terminal turn through the broker',
    })
    expect(start.spec.process.args).toEqual(
      expect.arrayContaining(['--', 'start the terminal turn through the broker'])
    )
  })

  test('does not allocate an initial turn merely to prepare an empty interactive terminal route', async () => {
    const result = await execution({
      namespace: 'interactive-claude-empty',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      omitPriming: true,
    })
    expect(result.dispatchRequest.startRequest.initialInput).toBeUndefined()
    expect(result.dispatchRequest.startRequest.spec.process.harnessTransport).toEqual({
      kind: 'pty',
    })
  })

  test.each([
    ['claude', 'anthropic', 'claude-sonnet-4-5', 'claude-code-tmux'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', 'muse-cli-tmux'],
  ] as const)(
    'keeps %s presentation preparation broker-owned through the %s start request',
    async (harness, modelProvider, model, driver) => {
      const result = await execution({
        namespace: `interactive-broker-owned-${harness}`,
        harness,
        modelProvider,
        model,
        presentation: true,
      })
      expect(result.driver).toBe(driver)
      expect(result.dispatchRequest.startRequest.spec.driver.kind).toBe(driver)
      expect(result.dispatchRequest.startRequest.spec).not.toHaveProperty('foreground')
    }
  )
})
