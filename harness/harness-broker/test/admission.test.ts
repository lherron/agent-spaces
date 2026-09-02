import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { BROKER_ADMISSION_JSON_SCHEMAS } from '../src/json-schema'
import { createTestDriver } from '../src/testing/test-driver'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const origin: SubmissionOrigin = { principalRef: 'agent:test', scopeRef: 'test@agent-spaces' }

const spec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: { kind: 'test-driver' },
})

async function setup(
  invocationId: string,
  options: Parameters<typeof createTestDriver>[0] = {},
  brokerOptions: { authorizeSubmission?: () => boolean } = {}
) {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver({
    supportsSteer: true,
    ...options,
  })
  const broker = createBroker({
    drivers: [driver],
    onEvent: (event) => events.push(event),
    authorizeSubmission: brokerOptions.authorizeSubmission,
  })
  await broker.start({ spec: spec(invocationId) })
  return { broker, controller, events, invocationId }
}

function eventsFor(events: InvocationEventEnvelope[], type: InvocationEventEnvelope['type']) {
  return events.filter((event) => event.type === type)
}

describe('broker admission API', () => {
  test('frozen steer JSON schema excludes turn policy and all unknown options', () => {
    expect(BROKER_ADMISSION_JSON_SCHEMAS.steerRequest.properties).not.toHaveProperty('turnPolicy')
    expect(BROKER_ADMISSION_JSON_SCHEMAS.steerRequest.additionalProperties).toBe(false)
  })

  for (const admissionClass of ['steer', 'enqueue', 'invoke', 'preempt'] as const) {
    for (const seatState of ['idle', 'busy'] as const) {
      test(`${admissionClass} has the specified immediate admission result while ${seatState}`, async () => {
        const invocationId = `inv_admission_${admissionClass}_${seatState}`
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
    const turnId = (executed[0]?.payload as { turnId: string }).turnId
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
    expect(
      eventsFor(events, 'submission.rejected').filter(
        (event) => event.payload.submissionId === rejected.submissionId
      )
    ).toHaveLength(1)
  })

  test('enqueue holds while busy, supports list/jump/cancel, then drains FIFO as own turns', async () => {
    const { broker, controller, events, invocationId } = await setup('inv_admission_queue')
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()

    const one = await broker.enqueue({ invocationId, origin, body: 'one' })
    const two = await broker.enqueue({ invocationId, origin, body: 'two' })
    const three = await broker.enqueue({ invocationId, origin, body: 'three' })
    expect(
      (await broker.queueList({ invocationId })).entries.map((entry) => entry.submissionId)
    ).toEqual([one.submissionId, two.submissionId, three.submissionId])
    expect(
      await broker.queueJump({
        invocationId,
        submissionId: three.submissionId,
        position: 0,
        principalRef: 'agent:test',
      })
    ).toEqual({ jumped: false, reason: 'authority-denied' })
    expect(
      await broker.queueCancel({
        invocationId,
        submissionId: two.submissionId,
        principalRef: origin.principalRef,
      })
    ).toEqual({ cancelled: true })

    controller.completeActiveTurn()
    await flush()
    expect(controller.activeInput?.inputId).toBe(one.submissionId)
    controller.completeActiveTurn()
    await flush()
    expect(controller.activeInput?.inputId).toBe(three.submissionId)
    controller.completeActiveTurn()
    await flush()

    expect(
      eventsFor(events, 'submission.executed')
        .map((event) => event.payload.submissionId)
        .filter((id) => id === one.submissionId || id === three.submissionId)
    ).toEqual([one.submissionId, three.submissionId])
    expect(
      eventsFor(events, 'submission.cancelled').filter(
        (event) => event.payload.submissionId === two.submissionId
      )
    ).toHaveLength(1)
  })

  test('broker-held TTL expires exactly once while the seat remains busy', async () => {
    const { broker, events, invocationId } = await setup('inv_admission_ttl')
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    const queued = await broker.enqueue({ invocationId, origin, body: 'stale', ttlMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect((await broker.queueList({ invocationId })).entries).toEqual([])
    expect(
      eventsFor(events, 'submission.expired').filter(
        (event) => event.payload.submissionId === queued.submissionId
      )
    ).toHaveLength(1)
    expect(eventsFor(events, 'queue.expired')).toHaveLength(1)
  })

  test('harness-evidence delivery reserves the seat until each observed turn starts', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_evidence_fifo',
      { bracketMintingMode: 'harness-evidence', suppressTurnStarted: true }
    )

    const queued = await Promise.all(
      ['one', 'two', 'three'].map((body) => broker.enqueue({ invocationId, origin, body }))
    )
    await flush()

    expect(controller.inputs).toHaveLength(1)
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'starting' })
    expect((await broker.queueList({ invocationId })).entries).toHaveLength(2)

    for (let index = 0; index < queued.length; index += 1) {
      expect(controller.activeInput?.inputId).toBe(queued[index]?.submissionId)
      controller.observeActiveTurnStart()
      await flush()
      controller.completeActiveTurn()
      await flush()
    }

    expect(controller.inputs.map((input) => input.inputId)).toEqual(
      queued.map((submission) => submission.submissionId)
    )
    expect(eventsFor(events, 'submission.executed')).toHaveLength(3)
  })

  test('steer is absorbed on open turns and rejected by guarded turn policy', async () => {
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
    expect(eventsFor(open.events, 'submission.absorbed').at(-1)?.payload).toMatchObject({
      submissionId: steered.submissionId,
    })
    const turnId = (
      eventsFor(open.events, 'submission.absorbed').at(-1)?.payload as
        | { turnId?: string }
        | undefined
    )?.turnId
    expect(turnId).toBeDefined()
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
    expect(atomic.controller.activeInput?.inputId).toBe(preempt.submissionId)
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
