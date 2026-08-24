/**
 * T-04408 RED — test 2: broker ingress rejects invalid dispatchEnv
 *
 * Currently broker.start() validates dispatchEnv via validateInvocationDispatchRequest
 * (protocol schema layer) which converts to BrokerError code -32602 (InvalidParams).
 *
 * After T-04408: parseDispatchEnv gates the broker.start() ingress and throws
 * BrokerError(DispatchValidationFailed = -32010) BEFORE any driver sees the input.
 *
 * RED failure: these tests expect code -32010 (DispatchValidationFailed) but
 * currently get -32602 (InvalidParams from the protocol schema validator).
 *
 * GREEN: clod adds parseDispatchEnv call at broker.start() ingress → code -32010.
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
  test('ambient key (HOME) → DispatchValidationFailed, not InvalidParams', async () => {
    // RED: currently resolves to BrokerError(-32602) from toInvalidParamsBrokerError().
    // GREEN: parseDispatchEnv at broker.start() ingress → BrokerError(-32010).
    const broker = createBroker({ drivers: [createNoopDriver()] })
    await expect(broker.start({ spec: noopSpec() }, { HOME: '/home' })).rejects.toMatchObject({
      code: BrokerErrorCode.DispatchValidationFailed,
    })
  })

  test('credential key (OPENAI_API_KEY) → DispatchValidationFailed before driver starts', async () => {
    // RED: same as above — currently -32602, expected -32010.
    const broker = createBroker({ drivers: [createNoopDriver()] })
    await expect(
      broker.start({ spec: noopSpec() }, { OPENAI_API_KEY: 'sk-test' })
    ).rejects.toMatchObject({ code: BrokerErrorCode.DispatchValidationFailed })
  })

  test('dispatchEnv shadows lockedEnv key → DispatchValidationFailed at ingress', async () => {
    // RED: same as above — currently -32602, expected -32010.
    const broker = createBroker({ drivers: [createNoopDriver()] })
    await expect(
      broker.start({ spec: specWithLockedEnv() }, { CODEX_HOME: '/other' })
    ).rejects.toMatchObject({ code: BrokerErrorCode.DispatchValidationFailed })
  })

  test('reserved key (NODE_ENV) → DispatchValidationFailed at ingress', async () => {
    // RED: same as above — currently -32602, expected -32010.
    const broker = createBroker({ drivers: [createNoopDriver()] })
    await expect(broker.start({ spec: noopSpec() }, { NODE_ENV: 'test' })).rejects.toMatchObject({
      code: BrokerErrorCode.DispatchValidationFailed,
    })
  })

  test('non-string value in dispatchEnv → DispatchValidationFailed at ingress', async () => {
    // RED: same as above — currently -32602, expected -32010.
    const broker = createBroker({ drivers: [createNoopDriver()] })
    await expect(
      broker.start({ spec: noopSpec() }, { MY_VAR: 42 } as unknown as Record<string, string>)
    ).rejects.toMatchObject({ code: BrokerErrorCode.DispatchValidationFailed })
  })
})
