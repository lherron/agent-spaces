/**
 * Ph6 RED tests: harness-broker/0.1 removal from broker protocol (T-01867)
 *
 * Asserts the TARGET end state where v0.1 is gone from protocol constants and
 * validators reject any command that advertises v0.1 versions.
 * ALL tests in this file FAIL today and pass after Ph6 is applied (green).
 */
import { describe, expect, test } from 'bun:test'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from '../src/invocation'
import { validateCommand } from '../src/schemas'

describe('Ph6 red: harness-broker/0.1 removal — protocol constants (T-01867)', () => {
  test('SUPPORTED_BROKER_PROTOCOL_VERSIONS does NOT contain harness-broker/0.1', () => {
    // RED today: array is ['harness-broker/0.1', 'harness-broker/0.2']
    expect(SUPPORTED_BROKER_PROTOCOL_VERSIONS).not.toContain('harness-broker/0.1')
  })

  test('SUPPORTED_BROKER_PROTOCOL_VERSIONS equals exactly ["harness-broker/0.2"]', () => {
    // RED today: has two entries — v0.1 is still present
    expect(Array.from(SUPPORTED_BROKER_PROTOCOL_VERSIONS)).toEqual(['harness-broker/0.2'])
  })
})

describe('Ph6 red: harness-broker/0.1 removal — broker.hello validator (T-01867)', () => {
  test('validateCommand rejects broker.hello with protocolVersions containing harness-broker/0.1', () => {
    // RED today: validateBrokerHelloParams only checks it's a string array; no value validation
    expect(() =>
      validateCommand({
        jsonrpc: '2.0',
        id: 1,
        method: 'broker.hello',
        params: {
          clientInfo: { name: 'test-client', version: '0.1.0' },
          protocolVersions: ['harness-broker/0.1'],
        },
      })
    ).toThrow()
  })

  test('validateCommand rejects broker.hello with mixed v0.1+v0.2 protocolVersions', () => {
    // RED today: mixed list also passes validation without error
    expect(() =>
      validateCommand({
        jsonrpc: '2.0',
        id: 2,
        method: 'broker.hello',
        params: {
          clientInfo: { name: 'test-client', version: '0.1.0' },
          protocolVersions: ['harness-broker/0.2', 'harness-broker/0.1'],
        },
      })
    ).toThrow()
  })

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
