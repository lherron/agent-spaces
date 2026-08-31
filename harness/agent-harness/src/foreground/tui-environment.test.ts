import { describe, expect, test } from 'bun:test'

import { applyAgentHarnessTuiEnvironment } from './tui'

describe('agent-harness Pi TUI environment', () => {
  test('enables Pi full redraws when transient UI rows shrink', () => {
    const environment: NodeJS.ProcessEnv = {}

    applyAgentHarnessTuiEnvironment(environment)

    expect(environment['PI_CLEAR_ON_SHRINK']).toBe('1')
  })

  test.each(['0', '1'])('preserves an explicit PI_CLEAR_ON_SHRINK=%s override', (value) => {
    const environment: NodeJS.ProcessEnv = { PI_CLEAR_ON_SHRINK: value }

    applyAgentHarnessTuiEnvironment(environment)

    expect(environment['PI_CLEAR_ON_SHRINK']).toBe(value)
  })
})
