/**
 * Moved from packages/aspc/test/v01-removal.red.test.ts by the T-07318 facade
 * split. Ph6 (T-01867) pinned that a CO-HOSTED `aspc.hello` surfaces
 * `brokerProtocol: 'harness-broker/0.2'`; after the split the co-hosted service
 * lives in the composition package, so the pin moves with it. The broker-less
 * direction stays in packages/aspc/test/v01-removal.red.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import type { Broker } from 'spaces-harness-broker'
import { createCohostedAspcService } from '../src/index.js'

// Minimal Broker stub — hello() only inspects `broker !== undefined`; the
// actual Broker interface is not called during `aspc.hello`.
const fakeBroker = {} as Broker

describe('Ph6 red: cohosted aspc.hello brokerProtocol surface (T-01867)', () => {
  test('hello() with co-hosted broker returns brokerProtocol harness-broker/0.2', async () => {
    const service = createCohostedAspcService({ broker: fakeBroker })
    const response = await service.hello({})
    expect(response.brokerProtocol).toBe('harness-broker/0.2')
  })

  test('hello() with co-hosted broker does NOT return brokerProtocol harness-broker/0.1', async () => {
    const service = createCohostedAspcService({ broker: fakeBroker })
    const response = await service.hello({})
    expect(response.brokerProtocol).not.toBe('harness-broker/0.1')
  })
})
