import { describe, expect, test } from 'bun:test'
import { eventsFor, eventsForSubmission, flush, origin, setup, submissionIdOf } from './fixture'

describe('broker admission API: broker-held queue and withdrawal', () => {
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
    expect<string | undefined>(controller.activeInput?.inputId).toBe(one.submissionId)
    controller.completeActiveTurn()
    await flush()
    expect<string | undefined>(controller.activeInput?.inputId).toBe(three.submissionId)
    controller.completeActiveTurn()
    await flush()

    expect(
      eventsFor(events, 'submission.executed')
        .map((event) => event.payload.submissionId)
        .filter((id) => id === one.submissionId || id === three.submissionId)
    ).toEqual([one.submissionId, three.submissionId])
    expect(eventsForSubmission(events, 'submission.cancelled', two.submissionId)).toHaveLength(1)
  })

  test('broker-held TTL expires exactly once while the seat remains busy', async () => {
    const { broker, events, invocationId } = await setup('inv_admission_ttl')
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    const queued = await broker.enqueue({ invocationId, origin, body: 'stale', ttlMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect((await broker.queueList({ invocationId })).entries).toEqual([])
    expect(eventsForSubmission(events, 'submission.expired', queued.submissionId)).toHaveLength(1)
    expect(eventsFor(events, 'queue.expired')).toHaveLength(1)
  })

  test('held submission withdrawal clears TTL and emits ordered terminal events', async () => {
    const { broker, events, invocationId } = await setup('inv_admission_withdraw_held')
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    const queued = await broker.enqueue({ invocationId, origin, body: 'stale', ttlMs: 5 })

    expect(
      await broker.withdraw({ submissionId: queued.submissionId, reason: 'envelope-acked' })
    ).toEqual({ outcome: 'withdrawn' })
    expect((await broker.queueList({ invocationId })).entries).toEqual([])
    expect(
      events
        .filter((event) => submissionIdOf(event) === queued.submissionId)
        .map((event) => event.type)
        .slice(-2)
    ).toEqual(['queue.withdrawn', 'submission.withdrawn'])
    expect(eventsFor(events, 'queue.withdrawn').at(-1)?.payload).toEqual({
      submissionId: queued.submissionId,
      reason: 'envelope-acked',
      position: 0,
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(eventsForSubmission(events, 'submission.expired', queued.submissionId)).toHaveLength(0)
  })

  test('withdraw reports accepted and terminal submissions as not held without events', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_withdraw_not_held',
      { bracketMintingMode: 'harness-evidence', suppressTurnStarted: true }
    )
    const accepted = await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    const acceptedEventCount = events.length
    expect(
      await broker.withdraw({ submissionId: accepted.submissionId, reason: 'too-late' })
    ).toEqual({ outcome: 'not_held', state: 'accepted' })
    expect(events).toHaveLength(acceptedEventCount)

    controller.observeActiveTurnStart()
    controller.completeActiveTurn()
    await flush()
    const terminalEventCount = events.length
    expect(
      await broker.withdraw({ submissionId: accepted.submissionId, reason: 'still-too-late' })
    ).toEqual({ outcome: 'not_held', state: 'terminal' })
    expect(events).toHaveLength(terminalEventCount)
  })

  test('withdraw reports an unknown submission without events', async () => {
    const { broker, events } = await setup('inv_admission_withdraw_unknown')
    const eventCount = events.length
    expect(
      await broker.withdraw({ submissionId: 'submission_missing', reason: 'not-found' })
    ).toEqual({ outcome: 'unknown' })
    expect(events).toHaveLength(eventCount)
  })

  test('envelope selector withdraws every matching held submission', async () => {
    const { broker, events, invocationId } = await setup('inv_admission_withdraw_envelope')
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    const envelopeOrigin = { ...origin, envelopeId: 'EN-withdraw-all' }
    const matches = await Promise.all([
      broker.enqueue({ invocationId, origin: envelopeOrigin, body: 'one' }),
      broker.enqueue({ invocationId, origin: envelopeOrigin, body: 'two' }),
    ])
    await broker.enqueue({
      invocationId,
      origin: { ...origin, envelopeId: 'EN-keep' },
      body: 'keep',
    })

    expect(
      await broker.withdraw({ envelopeId: 'EN-withdraw-all', reason: 'envelope-acked' })
    ).toEqual({ outcome: 'withdrawn' })
    expect((await broker.queueList({ invocationId })).entries).toHaveLength(1)
    expect(
      eventsFor(events, 'submission.withdrawn')
        .map((event) => event.payload.submissionId)
        .filter((submissionId) => matches.some((match) => match.submissionId === submissionId))
    ).toEqual(matches.map((match) => match.submissionId))
    expect(await broker.withdraw({ envelopeId: 'EN-missing', reason: 'envelope-acked' })).toEqual({
      outcome: 'unknown',
    })
  })

  test('preempt-class held submission is withdrawable', async () => {
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_withdraw_preempt',
      { preemptMode: 'quiescence', deferInterruptTerminal: true }
    )
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    controller.startToolCall('tool-withdraw-preempt')
    controller.setHarnessLocalQueueDepth(1)
    const preempt = await broker.preempt({ invocationId, origin, body: 'preempt' })
    await flush()

    expect(
      (await broker.queueList({ invocationId })).entries.find(
        (entry) => entry.submissionId === preempt.submissionId
      )
    ).toMatchObject({ class: 'preempt' })
    expect(
      await broker.withdraw({ submissionId: preempt.submissionId, reason: 'superseded' })
    ).toEqual({ outcome: 'withdrawn' })
    expect(eventsForSubmission(events, 'submission.withdrawn', preempt.submissionId)).toHaveLength(
      1
    )
  })

  test('withdrawal while a drain is in flight never submits the withdrawn record', async () => {
    let releaseFirstDrain: (() => void) | undefined
    const firstDrainGate = new Promise<void>((resolve) => {
      releaseFirstDrain = resolve
    })
    const { broker, controller, events, invocationId } = await setup(
      'inv_admission_withdraw_drain_race',
      {
        beforeApplyInput: async (input) => {
          if (input.content[0]?.type === 'text' && input.content[0].text === 'first') {
            await firstDrainGate
          }
        },
      }
    )
    await broker.invoke({ invocationId, origin, body: 'active' })
    await flush()
    const first = await broker.enqueue({ invocationId, origin, body: 'first' })
    const withdrawn = await broker.enqueue({ invocationId, origin, body: 'withdraw-me' })

    controller.completeActiveTurn()
    await flush()
    expect(
      eventsFor(events, 'input.accepted').some(
        (event) => event.payload.inputId === first.submissionId
      )
    ).toBe(true)
    expect(
      await broker.withdraw({ submissionId: withdrawn.submissionId, reason: 'race-test' })
    ).toEqual({ outcome: 'withdrawn' })

    releaseFirstDrain?.()
    await flush()
    controller.completeActiveTurn()
    await flush()
    expect(controller.inputs.some((input) => input.inputId === withdrawn.submissionId)).toBe(false)
    expect(
      eventsFor(events, 'input.accepted').some(
        (event) => event.payload.inputId === withdrawn.submissionId
      )
    ).toBe(false)
  })
})
