import { describe, expect, test } from 'bun:test'
import { inputIdFrom } from '../ids'
import { eventsFor, eventsForSubmission, flush, origin, setup } from './fixture'

describe('broker admission API: steer semantics', () => {
  test('a driver that declares steer but cannot write one takes it through its queue', async () => {
    // admission.classes is a deliberate driver DECLARATION and is not
    // cross-checked against applySteerNow presence. A steer is never refused
    // for capability on a live seat (T-13689): it routes through the queue.
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_steer_unsupported',
      {
        supportsSteer: false,
        admissionClasses: ['steer', 'queue', 'exclusive'],
      }
    )
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    expect((await broker.seatProbe({ invocationId })).seat.state).toBe('turn-active')

    const routed = await broker.steer({ invocationId, origin, body: 'through the queue' })
    await flush()
    expect(routed.admission).toBe('admitted')
    expect(eventsForSubmission(events, 'queue.enqueued', routed.submissionId)).toHaveLength(1)
    expect(
      eventsFor(events, 'input.rejected').filter(
        (event) => (event.payload as { inputId?: string }).inputId === routed.submissionId
      )
    ).toHaveLength(0)

    controller.completeActiveTurn()
    await flush()
    expect(controller.inputs.at(-1)?.inputId as string | undefined).toBe(routed.submissionId)
    expect(eventsForSubmission(events, 'submission.executed', routed.submissionId)).toHaveLength(1)
  })

  test('an idle steer the driver refuses before its first write reports not_written on input.rejected', async () => {
    // EN-38597: an idle steer goes through applyInputNow; the driver's quiescence
    // gate refused before the paste with typed not_written evidence. The mail
    // injector reads that proof from input.rejected only, so a bare
    // submission.rejected parked the envelope forever (T-12119).
    const { broker, events, invocationId } = await setup('inv_idle_steer_refused_unwritten', {
      beforeApplyInput: async () => {
        throw Object.assign(new Error('pane_not_quiescent'), {
          deliveryEvidence: 'not_written' as const,
        })
      },
    })

    const refused = await broker.steer({ invocationId, origin, body: 'never pasted' })
    await flush()

    expect(
      eventsFor(events, 'input.rejected').filter(
        (event) => (event.payload as { inputId?: string }).inputId === refused.submissionId
      )
    ).toMatchObject([
      { payload: { reason: 'pane_not_quiescent', deliveryEvidence: 'not_written' } },
    ])
    expect(eventsForSubmission(events, 'submission.rejected', refused.submissionId)).toMatchObject([
      { payload: { reason: 'pane_not_quiescent' } },
    ])
  })

  test('an idle steer never starts a turn when the driver requires strict steer semantics', async () => {
    const run = await setup('inv_strict_idle_steer')
    Object.defineProperty(run.driver, 'steerNeverStartsTurn', { value: true })

    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'do not start a turn',
    })
    await flush()

    expect(run.controller.inputs).toHaveLength(0)
    expect<(string | undefined)[]>(
      run.controller.steeredInputs.map((input) => input.inputId)
    ).toEqual([steered.submissionId])
    expect(eventsFor(run.events, 'turn.started')).toHaveLength(0)
    expect(eventsFor(run.events, 'input.accepted').at(-1)?.payload).toMatchObject({
      inputId: steered.submissionId,
      disposition: 'attempted_steer',
    })
  })

  test('steer stays pending until evidence on open turns and waits out a guarded turn', async () => {
    const open = await setup('inv_admission_steer_open')
    const started = await open.broker.invoke({
      invocationId: open.invocationId,
      origin,
      body: 'active',
    })
    await flush()
    const steered = await open.broker.steer({
      invocationId: open.invocationId,
      origin,
      body: 'join',
    })
    await flush()
    expect(steered.admission).toBe('admitted')
    expect(eventsFor(open.events, 'input.accepted').at(-1)?.payload).toMatchObject({
      inputId: steered.submissionId,
      disposition: 'attempted_steer',
    })
    expect(eventsFor(open.events, 'submission.absorbed')).toHaveLength(0)
    const turnId = open.controller.activeTurnId
    expect(turnId).toBeDefined()
    open.controller.emitRaw(
      'submission.absorbed',
      { submissionId: steered.submissionId, turnId: turnId! },
      { turnId: turnId!, inputId: inputIdFrom(steered.submissionId) }
    )
    expect(
      await open.broker.turnManifest({ invocationId: open.invocationId, turnId: turnId! })
    ).toMatchObject({
      submissionIds: [started.submissionId, steered.submissionId],
    })

    const guarded = await setup('inv_admission_steer_guarded')
    await guarded.broker.invoke({
      invocationId: guarded.invocationId,
      origin,
      body: 'guarded',
      turnPolicy: 'guarded',
    })
    await flush()
    const held = await guarded.broker.steer({
      invocationId: guarded.invocationId,
      origin,
      body: 'do not join',
    })
    await flush()
    // T-13689: admitted and held; a guarded turn is never steered into.
    expect(held).toMatchObject({ admission: 'admitted' })
    expect(eventsFor(guarded.events, 'admission.rejected')).toHaveLength(0)
    expect(guarded.controller.steeredInputs).toHaveLength(0)
    guarded.controller.completeActiveTurn()
    await flush()
    expect(guarded.controller.inputs.at(-1)?.inputId as string | undefined).toBe(held.submissionId)
  })

  test.each(['ack', 'asserted', null] as const)(
    'does not infer steer absorption from %s landing evidence',
    async (landingEvidence) => {
      const run = await setup(`inv_no_inferred_absorption_${landingEvidence ?? 'none'}`, {
        steerLandingEvidence: landingEvidence,
      })
      await run.broker.invoke({ invocationId: run.invocationId, origin, body: 'active' })
      await flush()

      const steered = await run.broker.steer({
        invocationId: run.invocationId,
        origin,
        body: 'accepted but not evidenced',
      })
      await flush()

      expect(steered.admission).toBe('admitted')
      expect(
        eventsForSubmission(run.events, 'submission.absorbed', steered.submissionId)
      ).toHaveLength(0)
    }
  )
})
