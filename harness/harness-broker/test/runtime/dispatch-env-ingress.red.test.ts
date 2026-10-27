/**
 * T-04408 — broker ingress rejects invalid dispatchEnv.
 *
 * parseDispatchEnv gates broker.start() and throws
 * BrokerError(DispatchValidationFailed = -32010), not InvalidParams (-32602),
 * BEFORE any driver sees the input.
 */
import { describe, expect, test } from 'bun:test'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createNoopDriver } from '../../src/drivers/noop-driver'
import { noopSpec } from '../helpers'

/** Spec with lockedEnv for shadow-rejection tests. */
const specWithLockedEnv = (): HarnessInvocationSpec => ({
  ...noopSpec(),
  process: {
    command: 'noop-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
    lockedEnv: { CODEX_HOME: '/workspace/.codex-home' },
  },
})

describe('T-04408 red 2 — broker ingress: invalid dispatchEnv rejected before driver', () => {
  // Every class shares code -32010 (DispatchValidationFailed), so each row also
  // asserts the key and the rule it broke: a key rejected for the WRONG reason
  // must fail here.
  test.each([
    { row: 'ambient key', dispatchEnv: { HOME: '/home' }, key: 'HOME', rule: 'ambient env' },
    {
      row: 'credential key',
      dispatchEnv: { OPENAI_API_KEY: 'sk-test' },
      key: 'OPENAI_API_KEY',
      rule: 'conflicts with credential env',
    },
    {
      row: 'reserved key',
      dispatchEnv: { NODE_ENV: 'test' },
      key: 'NODE_ENV',
      rule: 'is reserved',
    },
    {
      row: 'malformed key',
      dispatchEnv: { '9INVALID': 'val' },
      key: '9INVALID',
      rule: 'must match',
    },
    {
      row: 'non-string value',
      dispatchEnv: { MY_VAR: 42 },
      key: 'MY_VAR',
      rule: 'value must be a string',
    },
    {
      row: 'lockedEnv-shadowing key',
      dispatchEnv: { CODEX_HOME: '/other' },
      key: 'CODEX_HOME',
      rule: 'must not shadow lockedEnv',
      locked: true,
    },
  ])(
    'broker.start rejects a $row dispatchEnv with DispatchValidationFailed naming the key and the rule it broke',
    async ({ dispatchEnv, key, rule, locked }) => {
      const broker = createBroker({ drivers: [createNoopDriver()] })
      const spec = locked === true ? specWithLockedEnv() : noopSpec()
      await expect(
        broker.start({ spec }, dispatchEnv as unknown as Record<string, string>)
      ).rejects.toMatchObject({
        code: BrokerErrorCode.DispatchValidationFailed,
        data: { key },
        message: expect.stringContaining(rule),
      })
      // Rejected BEFORE any driver saw it: no invocation exists.
      expect((await broker.listInvocations({})).invocations).toEqual([])
    }
  )
})
