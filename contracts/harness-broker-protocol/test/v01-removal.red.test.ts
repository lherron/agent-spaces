/**
 * Ph6 RED tests: harness-broker/0.1 removal from broker protocol (T-01867)
 *
 * Asserts the TARGET end state where v0.1 is gone from protocol constants and
 * validators reject any command that advertises v0.1 versions.
 * ALL tests in this file FAIL today and pass after Ph6 is applied (green).
 */
import { describe, expect, test } from 'bun:test'
import { validateCommand } from '../src/schemas'
import { expectInvalidCommand } from './schema-test-helpers'

describe('Ph6 red: harness-broker/0.1 removal — broker.hello validator (T-01867)', () => {
  test.each([
    { protocolVersions: ['harness-broker/0.1'], path: 'params.protocolVersions.0' },
    {
      protocolVersions: ['harness-broker/0.2', 'harness-broker/0.1'],
      path: 'params.protocolVersions.1',
    },
  ])(
    'broker.hello advertising harness-broker/0.1 anywhere in protocolVersions is refused: $protocolVersions',
    ({ protocolVersions, path }) => {
      expectInvalidCommand(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'broker.hello',
          params: { clientInfo: { name: 'test-client', version: '0.1.0' }, protocolVersions },
        },
        { path, code: 'unsupported_broker_protocol' }
      )
    }
  )

  test('validateCommand accepts broker.hello with only harness-broker/0.2', () => {
    // GREEN after fix: v0.2-only hello is the valid form
    // Still RED today because v0.2 passes, so this is a POSITIVE guard (not a red)
    // but we include it to assert the validator stays open to v0.2
    expect(() =>
      validateCommand({
        jsonrpc: '2.0',
        id: 3,
        method: 'broker.hello',
        params: {
          clientInfo: { name: 'test-client', version: '0.1.0' },
          protocolVersions: ['harness-broker/0.2'],
        },
      })
    ).not.toThrow()
  })
})
