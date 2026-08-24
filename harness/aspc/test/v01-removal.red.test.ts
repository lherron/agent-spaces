/**
 * Ph6 RED tests: ASPC hello brokerProtocol v0.1 removal (T-01867)
 *
 * The co-hosted direction (`brokerProtocol: 'harness-broker/0.2'`) moved to
 * harness/aspc-facade/test/v01-removal.red.test.ts with the co-hosted service
 * (T-07314 facade split). What remains here is the compile-only direction: a
 * facade with no co-hosted broker surfaces no `brokerProtocol` at all.
 */
import { describe, expect, test } from 'bun:test'
import { createAspcService } from '../src/service.js'

describe('Ph6 red: aspc.hello brokerProtocol surface (T-01867)', () => {
  test('hello() without broker does not surface brokerProtocol at all', async () => {
    const service = createAspcService({})
    const response = await service.hello({})
    expect(response.brokerProtocol).toBeUndefined()
  })
})
