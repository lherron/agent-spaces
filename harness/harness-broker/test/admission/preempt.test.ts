import { describe, expect, test } from 'bun:test'
import { eventsFor, eventsForSubmission, flush, origin, setup } from './fixture'

describe('broker admission API: preempt delivery and native wakeup degradation', () => {
  test('a failed preempt interrupt terminally rejects its unwritten submission', async () => {
    // The preempt body is broker-held; the interrupt is a precondition for
    // delivering it. If the interrupt fails, nothing was ever written, so the
    // refusal must stay terminal rather than defaulting to possibly-written.
    const { broker, events, invocationId } = await setup('inv_admission_preempt_interrupt_fail', {
      admissionClasses: ['steer', 'queue', 'exclusive', 'preempt'],
      interruptRejectionReason: 'interrupt refused by harness',
    })
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    expect((await broker.seatProbe({ invocationId })).seat.state).toBe('turn-active')

    const preempted = await broker.preempt({ invocationId, origin, body: 'never written' })
    await flush()

    expect(eventsFor(events, 'interrupt.failed')).not.toHaveLength(0)
    expect(eventsForSubmission(events, 'submission.rejected', preempted.submissionId)).toHaveLength(
      1
    )
  })

  test('native wakeup degradation is snapshot-visible and rejects only preempt/interrupt', async () => {
    const degraded = await setup('inv_admission_native_wakeup_lost', {
      admissionRejectionReason: (admissionClass) =>
        admissionClass === 'preempt' ? 'native_wakeup_lost' : undefined,
      runtimeHealth: () => ({ state: 'degraded', reason: 'native_wakeup_lost' }),
      interruptRejectionReason: 'native_wakeup_lost',
    })

    expect(await degraded.broker.snapshot({ invocationId: degraded.invocationId })).toMatchObject({
      liveness: { driver: { state: 'degraded', reason: 'native_wakeup_lost' } },
    })

    const invoked = await degraded.broker.invoke({
      invocationId: degraded.invocationId,
      origin,
      body: 'unaffected invoke',
    })
    expect(invoked.admission).toBe('admitted')
    await flush()
    expect(
      (
        await degraded.broker.steer({
          invocationId: degraded.invocationId,
          origin,
          body: 'unaffected steer',
        })
      ).admission
    ).toBe('admitted')
    expect(
      (
        await degraded.broker.enqueue({
          invocationId: degraded.invocationId,
          origin,
          body: 'unaffected enqueue',
        })
      ).admission
    ).toBe('admitted')

    const preempt = await degraded.broker.preempt({
      invocationId: degraded.invocationId,
      origin,
      body: 'must reject',
    })
    expect(preempt).toMatchObject({ admission: 'rejected', reason: 'native_wakeup_lost' })
    expect(eventsFor(degraded.events, 'admission.rejected').at(-1)?.payload).toMatchObject({
      layer: 'capability',
      reason: 'native_wakeup_lost',
    })
    expect(
      await degraded.broker.interrupt({
        invocationId: degraded.invocationId,
        scope: 'turn',
      })
    ).toEqual({
      accepted: false,
      effect: 'unsupported',
      reason: 'native_wakeup_lost',
    })

    degraded.controller.completeActiveTurn()
    await flush()
    degraded.controller.completeActiveTurn()
    await flush()
    expect(
      (
        await degraded.broker.invoke({
          invocationId: degraded.invocationId,
          origin,
          body: 'invoke remains supported',
        })
      ).admission
    ).toBe('admitted')

    const fresh = await setup('inv_admission_native_wakeup_fresh')
    expect(
      (
        await fresh.broker.preempt({
          invocationId: fresh.invocationId,
          origin,
          body: 'fresh preempt',
        })
      ).admission
    ).toBe('admitted')
  })

  test('native wakeup degradation promptly rejects an admitted held preempt', async () => {
    let nativeWakeupLost = false
    const degraded = await setup('inv_admission_held_native_wakeup_lost', {
      preemptMode: 'quiescence',
      deferInterruptTerminal: true,
      admissionRejectionReason: (admissionClass) =>
        admissionClass === 'preempt' && nativeWakeupLost ? 'native_wakeup_lost' : undefined,
    })

    await degraded.broker.invoke({
      invocationId: degraded.invocationId,
      origin,
      body: 'active tool turn',
    })
    await flush()
    const queued = await degraded.broker.enqueue({
      invocationId: degraded.invocationId,
      origin,
      body: 'unaffected queue item',
    })
    degraded.controller.startToolCall('tool-held-preempt')

    const preempt = await degraded.broker.preempt({
      invocationId: degraded.invocationId,
      origin,
      body: 'held until interrupt terminal',
    })
    await flush()
    expect(preempt.admission).toBe('admitted')
    expect(eventsFor(degraded.events, 'interrupt.landed')).toHaveLength(1)
    expect(
      (await degraded.broker.queueList({ invocationId: degraded.invocationId })).entries
    ).toEqual([
      expect.objectContaining({ submissionId: preempt.submissionId, class: 'preempt' }),
      expect.objectContaining({ submissionId: queued.submissionId, class: 'queue' }),
    ])

    nativeWakeupLost = true
    degraded.controller.notifyAdmissionStateChanged()
    await flush()

    expect(
      (await degraded.broker.queueList({ invocationId: degraded.invocationId })).entries
    ).toEqual([expect.objectContaining({ submissionId: queued.submissionId, class: 'queue' })])
    expect(
      eventsForSubmission(degraded.events, 'admission.rejected', preempt.submissionId)
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          class: 'preempt',
          layer: 'capability',
          reason: 'native_wakeup_lost',
        }),
      }),
    ])
    expect(
      eventsForSubmission(degraded.events, 'submission.rejected', preempt.submissionId)
    ).toHaveLength(1)
    expect(
      eventsForSubmission(degraded.events, 'submission.rejected', queued.submissionId)
    ).toHaveLength(0)
  })

  test('quiescence preempt waits for request evidence and accepts bounded drain slippage', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_admission_quiescence', {
      preemptMode: 'quiescence',
    })
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    controller.startToolCall('tool-base')
    controller.setHarnessLocalQueueDepth(3)
    const preempt = await broker.preempt({ invocationId, origin, body: 'after quiescence' })
    await flush()

    controller.startHarnessLocalTurn('local-fast')
    await flush()
    expect(eventsFor(events, 'interrupt.landed')).toHaveLength(1)
    controller.completeActiveTurn('completed before request evidence')
    await flush()

    for (const [inputId, toolCallId] of [
      ['local-1', 'tool-local-1'],
      ['local-2', 'tool-local-2'],
    ] as const) {
      controller.startHarnessLocalTurn(inputId)
      await flush()
      const landedBeforeEvidence = eventsFor(events, 'interrupt.landed').length
      controller.startToolCall(toolCallId)
      await flush()
      expect(eventsFor(events, 'interrupt.landed')).toHaveLength(landedBeforeEvidence + 1)
    }
    await flush()

    expect(eventsFor(events, 'interrupt.landed')).toHaveLength(3)
    expect(eventsFor(events, 'turn.interrupted')).toHaveLength(3)
    expect(eventsFor(events, 'turn.completed')).toHaveLength(1)
    expect(controller.activeInput?.inputId).toBe(preempt.submissionId)
  })

  test('quiescence injects preempt immediately when queue ops dequeue a dropped prompt', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_quiescence_dropped',
      { preemptMode: 'quiescence' }
    )
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    controller.setHarnessLocalQueueDepth(1)
    const preempt = await broker.preempt({ invocationId, origin, body: 'after dropped prompt' })
    await flush()

    controller.startToolCall('tool-base')
    await flush()
    expect(eventsFor(events, 'turn.interrupted')).toHaveLength(1)
    expect(controller.activeInput).toBeUndefined()

    controller.setHarnessLocalQueueDepth(0)
    await flush()
    expect(controller.activeInput?.inputId).toBe(preempt.submissionId)
    expect(eventsFor(events, 'submission.executed').at(-1)?.payload).toMatchObject({
      submissionId: preempt.submissionId,
    })
  })
})
