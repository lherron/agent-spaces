import { describe, expect, test } from 'bun:test'
import { eventsFor, eventsForSubmission, flush, origin, setup } from './fixture'

describe('broker admission API: steer semantics', () => {
  test('a pre-driver steer refusal is terminally rejected as not_written', async () => {
    // admission.classes is a deliberate driver DECLARATION and is not
    // cross-checked against applySteerNow presence (only input.busyPolicies is),
    // so a driver can admit a steer it cannot execute. That refusal happens
    // before any driver attempt: it must stay a truthful terminal rejection and
    // must not be mistaken for a possible write.
    const { broker, events, invocationId } = await setup('inv_admission_steer_unsupported', {
      supportsSteer: false,
      admissionClasses: ['steer', 'queue', 'exclusive'],
    })
    // A turn must be active, otherwise the steer is applied as a normal input.
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    expect((await broker.seatProbe({ invocationId })).seat.state).toBe('turn-active')

    const refused = await broker.steer({ invocationId, origin, body: 'cannot be written' })
    await flush()

    expect(
      eventsFor(events, 'input.rejected').filter(
        (event) => (event.payload as { inputId?: string }).inputId === refused.submissionId
      )
    ).toMatchObject([{ payload: { deliveryEvidence: 'not_written' } }])
    // Nothing reached a driver, so the submission is DISPOSED, not left
    // dangling as a possible write.
    expect(eventsForSubmission(events, 'submission.rejected', refused.submissionId)).toHaveLength(1)
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
    expect(run.controller.steeredInputs.map((input) => input.inputId)).toEqual([
      steered.submissionId,
    ])
    expect(eventsFor(run.events, 'turn.started')).toHaveLength(0)
    expect(eventsFor(run.events, 'input.accepted').at(-1)?.payload).toMatchObject({
      inputId: steered.submissionId,
      disposition: 'attempted_steer',
    })
  })

  test('steer stays pending until evidence on open turns and is rejected by guarded policy', async () => {
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
      { turnId: turnId!, inputId: steered.submissionId }
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
    const rejected = await guarded.broker.steer({
      invocationId: guarded.invocationId,
      origin,
      body: 'do not join',
    })
    expect(rejected).toMatchObject({ admission: 'rejected', reason: 'guarded' })
    expect(eventsFor(guarded.events, 'admission.rejected').at(-1)?.payload).toMatchObject({
      layer: 'policy',
    })
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
