import { describe, expect, test } from 'bun:test'
import { BROKER_ADMISSION_JSON_SCHEMAS } from '../../src/json-schema'
import { invocationIdFrom } from '../ids'
import { eventsFor, eventsForSubmission, flush, origin, setup } from './fixture'

describe('broker admission API: admission classes, invoke policy and authority', () => {
  test('frozen steer JSON schema excludes turn policy and all unknown options', () => {
    expect(BROKER_ADMISSION_JSON_SCHEMAS.steerRequest.properties).not.toHaveProperty('turnPolicy')
    expect(BROKER_ADMISSION_JSON_SCHEMAS.steerRequest.additionalProperties).toBe(false)
  })

  for (const admissionClass of ['steer', 'enqueue', 'invoke', 'preempt'] as const) {
    for (const seatState of ['idle', 'busy'] as const) {
      test(`${admissionClass} has the specified immediate admission result while ${seatState}`, async () => {
        const invocationId = invocationIdFrom(`inv_admission_${admissionClass}_${seatState}`)
        const { broker } = await setup(invocationId)
        if (seatState === 'busy') {
          await broker.invoke({ invocationId, origin, body: 'active' })
          await flush()
        }
        const response = await broker[admissionClass]({
          invocationId,
          origin,
          body: admissionClass,
        })
        expect(response.admission).toBe(
          admissionClass === 'invoke' && seatState === 'busy' ? 'rejected' : 'admitted'
        )
        if (admissionClass === 'invoke' && seatState === 'busy') {
          expect(response.reason).toBe('busy')
        }
      })
    }
  }

  test('invoke starts only while idle and records guarded policy, provenance, and manifest', async () => {
    const { broker, events, invocationId } = await setup('inv_admission_invoke')

    const admitted = await broker.invoke({
      invocationId,
      origin,
      body: 'exclusive turn',
      turnPolicy: 'guarded',
    })
    expect(admitted.admission).toBe('admitted')
    await flush()

    const probe = await broker.seatProbe({ invocationId })
    expect(probe.seat).toMatchObject({ state: 'turn-active', policy: 'guarded' })
    const executed = eventsFor(events, 'submission.executed')
    expect(executed).toHaveLength(1)
    expect(executed[0]?.provenance).toMatchObject({ sourceKind: 'broker' })
    const turnId = executed[0]?.payload.turnId
    if (turnId === undefined) throw new Error('expected an executed submission turn')
    expect(await broker.turnManifest({ invocationId, turnId })).toEqual({
      invocationId,
      turnId,
      policy: 'guarded',
      submissionIds: [admitted.submissionId],
    })

    const rejected = await broker.invoke({ invocationId, origin, body: 'must fail busy' })
    expect(rejected).toEqual({
      submissionId: rejected.submissionId,
      admission: 'rejected',
      reason: 'busy',
    })
    expect(eventsFor(events, 'admission.rejected').at(-1)?.payload).toMatchObject({
      layer: 'state',
      reason: 'busy',
    })
    expect(eventsForSubmission(events, 'submission.rejected', rejected.submissionId)).toHaveLength(
      1
    )
  })

  test('authority rejection is typed and preempt atomic interrupts then starts its own turn', async () => {
    const denied = await setup('inv_admission_authority', {}, { authorizeSubmission: () => false })
    const rejected = await denied.broker.invoke({
      invocationId: denied.invocationId,
      origin,
      body: 'denied',
    })
    expect(rejected).toMatchObject({ admission: 'rejected', reason: 'authority-denied' })
    expect(eventsFor(denied.events, 'admission.rejected').at(-1)?.payload).toMatchObject({
      layer: 'authority',
    })

    const atomic = await setup('inv_admission_preempt_atomic')
    await atomic.broker.invoke({ invocationId: atomic.invocationId, origin, body: 'active' })
    await flush()
    const preempt = await atomic.broker.preempt({
      invocationId: atomic.invocationId,
      origin,
      body: 'preempting turn',
    })
    await flush()
    expect(preempt.admission).toBe('admitted')
    expect(eventsFor(atomic.events, 'interrupt.landed')).toHaveLength(1)
    expect<string | undefined>(atomic.controller.activeInput?.inputId).toBe(preempt.submissionId)
  })
})
