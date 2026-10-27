import { describe, expect, test } from 'bun:test'

import { applyAgentHarnessTuiEnvironment } from './tui'

describe('agent-harness Pi TUI environment', () => {
  test.each([
    { environment: {}, expected: '1' },
    { environment: { PI_CLEAR_ON_SHRINK: '0' }, expected: '0' },
  ])(
    'sets full redraw default while preserving an explicit override',
    ({ environment, expected }) => {
      applyAgentHarnessTuiEnvironment(environment)

      expect((environment as NodeJS.ProcessEnv)['PI_CLEAR_ON_SHRINK']).toBe(expected)
    }
  )
})
