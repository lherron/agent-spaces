/**
 * Ph6 RED tests: ASPC hello brokerProtocol v0.1 removal (T-01867)
 *
 * Asserts the TARGET end state where aspc.hello surfaces `brokerProtocol:
 * 'harness-broker/0.2'` (not v0.1) when a co-hosted broker is present.
 *
 * Tests FAIL today because packages/aspc/src/service.ts line 68 hard-codes
 * `brokerProtocol: 'harness-broker/0.1'`. They pass after Ph6 updates it to v0.2.
 */
import { describe, expect, test } from 'bun:test'
import type { Broker } from 'spaces-harness-broker'
import { createAspcService } from '../src/service.js'

// Minimal Broker stub — hello() only inspects `broker !== undefined`; the
// actual Broker interface is not called during `aspc.hello`.
const fakeBroker = {} as Broker

describe('Ph6 red: aspc.hello brokerProtocol surface (T-01867)', () => {
  test('hello() with co-hosted broker returns brokerProtocol harness-broker/0.2', async () => {
    // RED today: service.ts emits `brokerProtocol: 'harness-broker/0.1'`
    const service = createAspcService({ broker: fakeBroker })
    const response = await service.hello({})
    expect(response.brokerProtocol).toBe('harness-broker/0.2')
  })

  test('hello() with co-hosted broker does NOT return brokerProtocol harness-broker/0.1', async () => {
    // RED today: brokerProtocol is 'harness-broker/0.1' in the returned response
    const service = createAspcService({ broker: fakeBroker })
    const response = await service.hello({})
    expect(response.brokerProtocol).not.toBe('harness-broker/0.1')
  })

  test('hello() without broker does not surface brokerProtocol at all', async () => {
    // GREEN today and after fix — broker absent means no brokerProtocol field
    const service = createAspcService({})
    const response = await service.hello({})
    expect(response.brokerProtocol).toBeUndefined()
  })
})
