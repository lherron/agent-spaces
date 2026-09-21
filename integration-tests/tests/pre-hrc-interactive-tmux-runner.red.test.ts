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
  test('derives the retained Claude terminal requirement from presentation', async () => {
    const result = await execution({
      namespace: 'interactive-claude',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      prompt: 'prepare an interactive Claude session',
    })
    expect(result).toMatchObject({
      driver: 'claude-code-tmux',
      hosting: { terminalRequired: true, terminalHost: 'tmux', executionTransport: 'pty' },
    })
    expect(result.dispatchRequest.startRequest.spec.process.harnessTransport).toEqual({
      kind: 'pty',
    })
  })

  test('keeps Claude terminal hosting when presentation is omitted because it is intrinsic', async () => {
    const result = await execution({
      namespace: 'interactive-claude-omitted',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
    })
    expect(result.driver).toBe('claude-code-tmux')
    expect(result.hosting).toMatchObject({ terminalRequired: true, terminalHost: 'tmux' })
  })

  test('selects native worker tmux hosting for presented agent harness work', async () => {
    const result = await execution({
      namespace: 'interactive-agent-harness',
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: true,
    })
    expect(result).toMatchObject({
      driver: 'agent-harness-tmux',
      hosting: {
        terminalRequired: true,
        terminalHost: 'tmux',
        executionTransport: 'native-worker',
      },
    })
  })

  test('selects Muse tmux hosting only when presentation is requested', async () => {
    const headless = await execution({
      namespace: 'interactive-muse-headless',
      harness: 'muse',
      modelProvider: 'meta',
      model: 'muse-spark-1.3-contributor',
      presentation: false,
    })
    const presented = await execution({
      namespace: 'interactive-muse-presented',
      harness: 'muse',
      modelProvider: 'meta',
      model: 'muse-spark-1.3-contributor',
      presentation: true,
    })
    expect(headless.hosting.terminalRequired).toBe(false)
    expect(presented).toMatchObject({
      driver: 'muse-cli-tmux',
      hosting: { terminalRequired: true, terminalHost: 'tmux' },
    })
  })

  test('materializes interactive Claude priming in the canonical broker input, not a foreground launch payload', async () => {
    const result = await execution({
      namespace: 'interactive-claude-input',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      prompt: 'start the terminal turn through the broker',
    })
    const start = result.dispatchRequest.startRequest
    expect(start.initialInput?.content).toEqual([
      { type: 'text', text: 'start the terminal turn through the broker' },
    ])
    expect(start.spec).not.toHaveProperty('launch')
    expect(start.spec.process.args).not.toContain('start the terminal turn through the broker')
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
