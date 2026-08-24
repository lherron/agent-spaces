import { expect, test } from 'bun:test'

import { createAgentHarnessDriver } from './index'

test('composes the broker with the first-party driver identity', () => {
  const driver = createAgentHarnessDriver()
  expect(driver.kind).toBe('agent-harness')
  expect(driver.capabilities().input.steer).toBe(true)
  expect(driver.capabilities().turns.interrupt).toBe('protocol')
})
