import { describe, expect, test } from 'bun:test'
import type { ArrisControlReceipt, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import {
  ArrisIndeterminateDeliveryError,
  ArrisNotWrittenError,
  ArrisRetryableNotWrittenError,
} from '../../../src/drivers/arris-resident/delivery-errors'
import { createArrisResidentDriver } from '../../../src/drivers/arris-resident/driver'
import { client, context, descriptor, receipt, spec } from './fixtures'

const steerInput = {
  inputId: 'submission-steer' as never,
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'steer me' }],
  metadata: { envelopeId: 'EN-steer' },
}

async function steerWith(outcome: ArrisControlReceipt['outcome']) {
  const events: InvocationEventEnvelope[] = []
  const driver = createArrisResidentDriver({
    pollIntervalMs: 60_000,
    readDescriptor: async () => descriptor(),
    createControlClient: () =>
      client({
        async steer(identity, target) {
          return {
            ...receipt(identity.input_id, identity.attempt, outcome),
            kind: 'steer',
            target_neutral_turn_id: target,
          }
        },
      }),
  })
  await driver.start(spec(), context(events))
  const error = await driver.applySteerNow?.(steerInput).then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  const holdDepth = driver.probeAdmissionState?.()?.harnessLocalQueueDepth
  await driver.dispose()
  return { error, holdDepth, events }
}

describe('Arris resident steer delivery outcomes', () => {
  test('a written steer resolves and records its receipt', async () => {
    const { error, holdDepth, events } = await steerWith({
      outcome: 'written',
      neutral_turn_id: 'turn:neutral-1',
      codex_turn_id: 'turn-codex-1',
    })
    expect(error).toBeUndefined()
    expect(holdDepth).toBe(0)
    const receipts = events.filter(
      (event) =>
        event.type === 'driver.notice' &&
        (event.payload as { code: string }).code === 'ARRIS_CONTROL_RECEIPT'
    )
    expect<Array<string | undefined>>(receipts.map((event) => event.inputId)).toEqual([
      'submission-steer',
    ])
  })

  test('a retry-eligible refusal holds admission and is retryable not_written', async () => {
    const { error, holdDepth } = await steerWith({
      outcome: 'not_written',
      code: 'host_busy',
      message: 'host is busy',
      eligible_for_retry: true,
      requeue_as_input_permitted: false,
    })
    expect(error).toBeInstanceOf(ArrisRetryableNotWrittenError)
    expect((error as { deliveryEvidence?: string }).deliveryEvidence).toBe('not_written')
    expect(holdDepth).toBe(1)
  })

  test('a final refusal is not_written without holding admission', async () => {
    const { error, holdDepth } = await steerWith({
      outcome: 'not_written',
      code: 'no_active_turn',
      message: 'no turn to steer',
      eligible_for_retry: false,
      requeue_as_input_permitted: false,
    })
    expect(error).toBeInstanceOf(ArrisNotWrittenError)
    expect(error).not.toBeInstanceOf(ArrisRetryableNotWrittenError)
    expect((error as Error).message).toBe('no turn to steer')
    expect(holdDepth).toBe(0)
  })

  test('an indeterminate steer is possibly_written', async () => {
    const { error } = await steerWith({
      outcome: 'indeterminate',
      code: 'acknowledgement_lost',
      message: 'write acknowledgement was lost',
    })
    expect(error).toBeInstanceOf(ArrisIndeterminateDeliveryError)
    expect((error as Error).message).toBe('write acknowledgement was lost')
    expect((error as { deliveryEvidence?: string }).deliveryEvidence).toBe('possibly_written')
  })
})
