import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createTestDriver } from '../../src/testing/test-driver'
import { testDriverSpec } from '../helpers'
import { eventsFor, flush, origin, setup } from './fixture'

describe('broker admission API: observed-bracket attribution holds and fails closed', () => {
  test('observed mode holds launch input in the real queue across an unattributed turn', async () => {
    const events: InvocationEventEnvelope[] = []
    const foreignTurn = 'turn_observed_launch' as const
    const { driver, controller } = createTestDriver({
      bracketMintingMode: 'observed',
      admissionClasses: ['steer', 'queue'],
      supportsSteer: true,
      onStart: (ctx) => {
        ctx.emit(
          'turn.started',
          { turnId: foreignTurn, source: 'observed' },
          { turnId: foreignTurn }
        )
        ctx.emit('invocation.ready', { state: 'ready' })
      },
    })
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
    const invocationId = 'inv_observed_launch'
    const initialInput = {
      inputId: 'input_observed_launch',
      kind: 'user' as const,
      content: [{ type: 'text' as const, text: 'launch through queue' }],
    }
    await broker.start({ spec: testDriverSpec(invocationId), initialInput })

    expect((await broker.seatProbe({ invocationId })).seat).toEqual({
      state: 'turn-observed',
      turnId: foreignTurn,
    })
    expect((await broker.queueList({ invocationId })).entries).toHaveLength(1)
    await expect(broker.turnManifest({ invocationId, turnId: foreignTurn })).rejects.toThrow(
      /not attributed/
    )
    // T-08527: a steer is a mid-turn action; an unattributed running turn is
    // still a running turn, so it is injected rather than refused.
    const steer = await broker.steer({ invocationId, origin, body: 'mid-turn' })
    expect(steer).toMatchObject({ admission: 'admitted' })
    await flush()
    expect(controller.steeredInputs.map((input) => input.inputId)).toEqual([
      steer.submissionId as never,
    ])

    controller.emitRaw(
      'turn.attributed',
      { turnId: foreignTurn, ownership: 'foreign', origin: 'human' },
      { turnId: foreignTurn }
    )
    expect(await broker.turnManifest({ invocationId, turnId: foreignTurn })).toMatchObject({
      policy: 'open',
      submissionIds: [],
    })
    expect((await broker.seatProbe({ invocationId })).seat).toMatchObject({
      state: 'turn-active',
      policy: 'open',
    })
    expect(eventsFor(events, 'submission.lost')).toHaveLength(0)
    expect(controller.inputs).toHaveLength(0)
    controller.emitRaw(
      'turn.completed',
      { turnId: foreignTurn, status: 'completed' },
      { turnId: foreignTurn }
    )
    await flush()
    expect(controller.inputs.map((input) => input.inputId)).toEqual(['input_observed_launch'])
  })

  test('observed launch input can be withdrawn while held behind startup attribution', async () => {
    const foreignTurn = 'turn_observed_withdraw' as const
    const { driver, controller } = createTestDriver({
      bracketMintingMode: 'observed',
      admissionClasses: ['steer', 'queue'],
      onStart: (ctx) => {
        ctx.emit(
          'turn.started',
          { turnId: foreignTurn, source: 'observed' },
          { turnId: foreignTurn }
        )
      },
    })
    const broker = createBroker({ drivers: [driver] })
    const invocationId = 'inv_observed_launch_withdraw'
    await broker.start({
      spec: testDriverSpec(invocationId),
      initialInput: {
        inputId: 'input_observed_launch_withdraw',
        kind: 'user',
        content: [{ type: 'text', text: 'withdraw me' }],
      },
    })
    expect(
      await broker.withdraw({
        submissionId: 'input_observed_launch_withdraw',
        reason: 'superseded',
      })
    ).toEqual({ outcome: 'withdrawn' })
    controller.emitRaw(
      'turn.attributed',
      { turnId: foreignTurn, ownership: 'foreign', origin: 'human' },
      { turnId: foreignTurn }
    )
    controller.emitRaw(
      'turn.completed',
      { turnId: foreignTurn, status: 'completed' },
      { turnId: foreignTurn }
    )
    await flush()
    expect(controller.inputs).toHaveLength(0)
  })

  test('retryable not-written keeps the same submission held until the driver signals', async () => {
    let attempts = 0
    const holder: { controller?: ReturnType<typeof createTestDriver>['controller'] } = {}
    const run = await setup('inv_retryable_not_written', {
      bracketMintingMode: 'observed',
      admissionClasses: ['queue', 'steer'],
      beforeApplyInput: async () => {
        attempts += 1
        if (attempts !== 1) return
        holder.controller?.setHarnessLocalQueueDepth(1)
        const error = Object.assign(new Error('host_busy'), {
          retryableNotWritten: true as const,
          deliveryEvidence: 'not_written' as const,
          receipt: { receipt_id: 'control-receipt:busy', attempts_seen: [1] },
        })
        throw error
      },
    })
    holder.controller = run.controller
    Object.defineProperty(run.driver, 'blocksAdmissionWhileHarnessLocalQueued', {
      value: true,
    })

    const admitted = await run.broker.enqueue({
      invocationId: run.invocationId,
      origin,
      body: 'same logical input',
    })
    await flush()
    expect(attempts).toBe(1)
    expect(await run.broker.queueList({ invocationId: run.invocationId })).toEqual({
      entries: [expect.objectContaining({ submissionId: admitted.submissionId })],
    })
    expect(eventsFor(run.events, 'submission.rejected')).toHaveLength(0)
    expect(eventsFor(run.events, 'diagnostic').at(-1)?.payload).toMatchObject({
      kind: 'submission_retryable_not_written',
      data: {
        submissionId: admitted.submissionId,
        receipt: { receipt_id: 'control-receipt:busy', attempts_seen: [1] },
      },
    })

    run.controller.setHarnessLocalQueueDepth(0)
    run.controller.notifyAdmissionStateChanged()
    await flush()
    expect(attempts).toBe(2)
    expect(run.controller.inputs.map((input) => input.inputId)).toEqual([admitted.submissionId])
    expect((await run.broker.queueList({ invocationId: run.invocationId })).entries).toHaveLength(0)
  })

  test('unknown attribution contests a pending observed delivery and fails closed at terminal', async () => {
    let releaseDelivery: (() => void) | undefined
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve
    })
    const { broker, controller, events, invocationId } = await setup(
      'inv_observed_unknown_terminal',
      {
        bracketMintingMode: 'observed',
        admissionClasses: ['steer', 'queue'],
        supportsSteer: true,
        beforeApplyInput: async () => deliveryGate,
      }
    )
    const pending = await broker.enqueue({ invocationId, origin, body: 'pending' })
    await flush()
    const unknownTurn = 'turn_observed_unknown' as const
    controller.emitRaw(
      'turn.started',
      { turnId: unknownTurn, source: 'observed' },
      { turnId: unknownTurn }
    )
    controller.emitRaw(
      'turn.attributed',
      { turnId: unknownTurn, ownership: 'unknown', origin: 'unknown' },
      { turnId: unknownTurn }
    )
    controller.emitRaw(
      'turn.completed',
      { turnId: unknownTurn, status: 'completed' },
      { turnId: unknownTurn }
    )
    await flush()

    expect(eventsFor(events, 'submission.lost')).toContainEqual(
      expect.objectContaining({
        payload: { submissionId: pending.submissionId, reason: 'turn-correlation-lost' },
      })
    )
    expect(eventsFor(events, 'invocation.failed').at(-1)?.payload).toMatchObject({
      code: 'submission_correlation_lost',
      retryable: false,
    })
    releaseDelivery?.()
  })
})
