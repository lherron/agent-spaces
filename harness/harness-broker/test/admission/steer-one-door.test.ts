import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationInput } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { withDeliveryEvidence, withSteerRequiresOwnTurn } from '../../src/drivers/driver'
import { BrokerError } from '../../src/errors'
import { SUBMISSION_TERMINAL_TYPES } from '../../src/invocation-constants'
import { TmuxPaneNotQuiescentError } from '../../src/runtime/tmux'
import { createTestDriver } from '../../src/testing/test-driver'
import { testDriverSpec } from '../helpers'
import { inputIdFrom, invocationIdFrom } from '../ids'
import { eventsFor, eventsForSubmission, flush, origin, setup } from './fixture'

/**
 * agent-spaces.broker-steer-one-door (T-13689): a steer to any live seat lands.
 * Every test asserts exactly one submission terminal for the steer.
 */

/** Every submission terminal about one submission, in order. */
function terminalsFor(events: InvocationEventEnvelope[], submissionId: string): string[] {
  return events
    .filter(
      (event) =>
        SUBMISSION_TERMINAL_TYPES.has(event.type) &&
        (event.payload as { submissionId?: string }).submissionId === submissionId
    )
    .map((event) => event.type)
}

function inputRejectedFor(events: InvocationEventEnvelope[], submissionId: string) {
  return eventsFor(events, 'input.rejected').filter(
    (event) => event.payload.inputId === submissionId
  )
}

const steeredIds = (inputs: InvocationInput[]): (string | undefined)[] =>
  inputs.map((input) => input.inputId)

/** Wait for a condition the broker reaches through timers or microtasks. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The driver reports the busy steer landed in the live turn. */
function absorb(
  run: Awaited<ReturnType<typeof setup>>,
  submissionId: string,
  turnId = run.controller.activeTurnId
): void {
  if (turnId === undefined) throw new Error('no active turn to absorb into')
  run.controller.emitRaw(
    'submission.absorbed',
    { submissionId, turnId },
    { turnId, inputId: inputIdFrom(submissionId) }
  )
}

describe('T-13689 steer one door: every live seat state', () => {
  test('idle: the steer starts its own turn', async () => {
    const run = await setup('inv_one_door_idle')
    const steered = await run.broker.steer({ invocationId: run.invocationId, origin, body: 'go' })
    await flush()

    expect(steered.admission).toBe('admitted')
    expect(steeredIds(run.controller.inputs)).toEqual([steered.submissionId])
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.executed'])
  })

  test('busy: the steer injects into the live turn', async () => {
    const run = await setup('inv_one_door_busy')
    await run.broker.invoke({ invocationId: run.invocationId, origin, body: 'active' })
    await flush()
    const steered = await run.broker.steer({ invocationId: run.invocationId, origin, body: 'join' })
    await flush()

    expect(steeredIds(run.controller.steeredInputs)).toEqual([steered.submissionId])
    expect(eventsFor(run.events, 'input.accepted').at(-1)?.payload).toMatchObject({
      inputId: steered.submissionId,
      disposition: 'attempted_steer',
    })
    absorb(run, steered.submissionId)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.absorbed'])
  })

  test('pending window: the steer waits for the handed-over turn, then injects', async () => {
    // A harness-evidence driver keeps the delivered body in the own-turn slot
    // until the harness opens its turn; its steer needs a live turn.
    let turnLive = false
    const run = await setup('inv_one_door_pending', {
      bracketMintingMode: 'harness-evidence',
      suppressTurnStarted: true,
      beforeApplySteer: async () => {
        if (!turnLive) {
          throw withSteerRequiresOwnTurn(
            withDeliveryEvidence(new Error('no active turn yet'), 'not_written')
          )
        }
      },
    })
    const handed = await run.broker.enqueue({
      invocationId: run.invocationId,
      origin,
      body: 'handed over',
    })
    await flush()
    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'after the handover',
    })
    await flush()
    expect(steered.admission).toBe('admitted')
    expect(steeredIds(run.controller.steeredInputs)).toEqual([])
    // The steer never started a second own turn while the slot was held.
    expect(steeredIds(run.controller.inputs)).toEqual([handed.submissionId])

    turnLive = true
    run.controller.observeActiveTurnStart()
    await flush()

    expect(steeredIds(run.controller.steeredInputs)).toEqual([steered.submissionId])
    expect(inputRejectedFor(run.events, steered.submissionId)).toHaveLength(0)
    absorb(run, steered.submissionId)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.absorbed'])
  })

  test.each([
    ['exclusive', ['steer', 'queue', 'exclusive']],
    ['queue', ['steer', 'queue']],
  ] as const)(
    'invocation starting: the steer is admitted at once, held, then runs behind a %s launch',
    async (launch, classes) => {
      const invocationId = invocationIdFrom(`inv_one_door_starting_${launch}`)
      const events: InvocationEventEnvelope[] = []
      let releaseStart: () => void = () => {}
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve
      })
      let driverStarted = false
      const { driver, controller } = createTestDriver({
        supportsSteer: true,
        admissionClasses: [...classes],
        onStart: async () => {
          driverStarted = true
          await startGate
        },
      })
      const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
      const started = broker.start({
        spec: testDriverSpec(invocationId),
        initialInput: { kind: 'user', content: [{ type: 'text', text: 'launch' }] },
      })
      await until(() => driverStarted, 'driver start')

      // The reply returns while the hold is still in force.
      const steered = await broker.steer({ invocationId, origin, body: 'while starting' })
      expect(steered.admission).toBe('admitted')
      await flush()
      expect(controller.inputs).toHaveLength(0)
      expect(controller.steeredInputs).toHaveLength(0)

      releaseStart()
      await started
      await flush()

      // The launch input took the seat first; the steer joined its turn.
      expect(controller.inputs.map((input) => input.content[0])).toMatchObject([{ text: 'launch' }])
      expect(steeredIds(controller.steeredInputs)).toEqual([steered.submissionId])
      controller.emitRaw(
        'submission.absorbed',
        { submissionId: steered.submissionId, turnId: controller.activeTurnId! },
        { turnId: controller.activeTurnId!, inputId: inputIdFrom(steered.submissionId) }
      )
      expect(terminalsFor(events, steered.submissionId)).toEqual(['submission.absorbed'])
    }
  )

  test('guarded turn: never steered into; the steer waits for its terminal and starts a turn', async () => {
    const run = await setup('inv_one_door_guarded')
    await run.broker.invoke({
      invocationId: run.invocationId,
      origin,
      body: 'guarded',
      turnPolicy: 'guarded',
    })
    await flush()
    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'after the guard',
    })
    await flush()

    expect(steered.admission).toBe('admitted')
    expect(eventsFor(run.events, 'admission.rejected')).toHaveLength(0)
    expect(run.controller.steeredInputs).toHaveLength(0)
    expect(run.controller.inputs).toHaveLength(1)

    run.controller.completeActiveTurn()
    await flush()

    expect(run.controller.steeredInputs).toHaveLength(0)
    expect(steeredIds(run.controller.inputs).at(-1)).toBe(steered.submissionId)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.executed'])
  })

  test('queue-only driver: the steer goes through the driver queue', async () => {
    const run = await setup('inv_one_door_queue_only', {
      supportsSteer: false,
      admissionClasses: ['queue'],
    })
    await run.broker.enqueue({ invocationId: run.invocationId, origin, body: 'active' })
    await flush()
    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'through the queue',
    })
    await flush()

    expect(steered.admission).toBe('admitted')
    expect(eventsForSubmission(run.events, 'queue.enqueued', steered.submissionId)).toMatchObject([
      { payload: { class: 'queue' } },
    ])
    expect(steeredIds(run.controller.inputs)).toHaveLength(1)

    run.controller.completeActiveTurn()
    await flush()

    expect(steeredIds(run.controller.inputs).at(-1)).toBe(steered.submissionId)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.executed'])
  })

  test('open permission request: held, then injects once the request resolves', async () => {
    const run = await setup('inv_one_door_permission')
    await run.broker.invoke({ invocationId: run.invocationId, origin, body: 'active' })
    await flush()
    const turnId = run.controller.activeTurnId!
    run.controller.emitRaw(
      'permission.requested',
      {
        permissionRequestId: 'perm_1',
        kind: 'tool',
        subjectDisplay: 'rm -rf build',
        defaultDecision: 'deny',
      },
      { turnId }
    )
    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'must not answer the prompt',
    })
    await flush()
    expect(steered.admission).toBe('admitted')
    expect(run.controller.steeredInputs).toHaveLength(0)

    run.controller.emitRaw(
      'permission.resolved',
      { permissionRequestId: 'perm_1', decision: 'allow', decidedBy: 'user' },
      { turnId }
    )
    await flush()

    expect(steeredIds(run.controller.steeredInputs)).toEqual([steered.submissionId])
    absorb(run, steered.submissionId)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.absorbed'])
  })

  test('open ask tool: held until the question is answered', async () => {
    const run = await setup('inv_one_door_ask')
    await run.broker.invoke({ invocationId: run.invocationId, origin, body: 'active' })
    await flush()
    run.controller.startToolCall('ask_1', 'AskUserQuestion')
    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'not an answer',
    })
    await flush()
    expect(run.controller.steeredInputs).toHaveLength(0)

    run.controller.completeToolCall('ask_1', 'AskUserQuestion')
    await flush()

    expect(steeredIds(run.controller.steeredInputs)).toEqual([steered.submissionId])
    absorb(run, steered.submissionId)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.absorbed'])
  })

  test('pane not ready before paste: retried silently until it lands', async () => {
    let refusals = 2
    const run = await setup(
      'inv_one_door_pane_before_paste',
      {
        beforeApplySteer: async () => {
          if (refusals > 0) {
            refusals -= 1
            throw withDeliveryEvidence(new TmuxPaneNotQuiescentError('before_paste'), 'not_written')
          }
        },
      },
      { steerRetryIntervalMs: 5 }
    )
    await run.broker.invoke({ invocationId: run.invocationId, origin, body: 'active' })
    await flush()
    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'waits for the box',
    })
    await until(() => run.controller.steeredInputs.length === 1, 'steer retry')

    expect(refusals).toBe(0)
    expect(steeredIds(run.controller.steeredInputs)).toEqual([steered.submissionId])
    // No attempt it went on to retry was reported.
    expect(inputRejectedFor(run.events, steered.submissionId)).toHaveLength(0)
    absorb(run, steered.submissionId)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.absorbed'])
  })

  test('idle pane not ready before paste: retried until the turn starts', async () => {
    let refusals = 1
    const run = await setup(
      'inv_one_door_idle_pane',
      {
        beforeApplyInput: async () => {
          if (refusals > 0) {
            refusals -= 1
            throw withDeliveryEvidence(new TmuxPaneNotQuiescentError('before_paste'), 'not_written')
          }
        },
      },
      { steerRetryIntervalMs: 5 }
    )
    const steered = await run.broker.steer({ invocationId: run.invocationId, origin, body: 'idle' })
    await until(() => run.controller.inputs.length === 1, 'idle steer retry')
    await flush()

    expect(inputRejectedFor(run.events, steered.submissionId)).toHaveLength(0)
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.executed'])
  })

  test('pane failure after submit is possibly_written, reported once and never re-pasted', async () => {
    let attempts = 0
    const run = await setup(
      'inv_one_door_after_submit',
      {
        beforeApplySteer: async () => {
          attempts += 1
          throw withDeliveryEvidence(
            new TmuxPaneNotQuiescentError('after_submit'),
            'possibly_written'
          )
        },
      },
      { steerRetryIntervalMs: 5 }
    )
    await run.broker.invoke({ invocationId: run.invocationId, origin, body: 'active' })
    await flush()
    const steered = await run.broker.steer({
      invocationId: run.invocationId,
      origin,
      body: 'maybe landed',
    })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(attempts).toBe(1)
    expect(inputRejectedFor(run.events, steered.submissionId)).toMatchObject([
      { payload: { deliveryEvidence: 'possibly_written' } },
    ])
    expect(terminalsFor(run.events, steered.submissionId)).toEqual([])
    await run.broker.stop({ invocationId: run.invocationId, reason: 'test teardown' })
    await flush()
    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.lost'])
  })

  test.each(['stopping', 'exited'] as const)(
    'a %s invocation refuses the steer not_written',
    async (state) => {
      const run = await setup(`inv_one_door_${state}`)
      if (state === 'stopping') {
        run.controller.emitRaw('invocation.stopping', { reason: 'test' })
      } else {
        await run.broker.stop({ invocationId: run.invocationId, reason: 'test teardown' })
      }
      await flush()
      const refused = await run.broker.steer({
        invocationId: run.invocationId,
        origin,
        body: 'too late',
      })
      await flush()

      expect(refused).toMatchObject({ admission: 'rejected', reason: `invalid-state:${state}` })
      expect(run.controller.inputs).toHaveLength(0)
      expect(run.controller.steeredInputs).toHaveLength(0)
      expect(terminalsFor(run.events, refused.submissionId)).toEqual(['submission.rejected'])
    }
  )

  test('a held steer is cancelled, not lost, when the invocation ends', async () => {
    const run = await setup('inv_one_door_held_teardown')
    await run.broker.invoke({
      invocationId: run.invocationId,
      origin,
      body: 'guarded',
      turnPolicy: 'guarded',
    })
    await flush()
    const steered = await run.broker.steer({ invocationId: run.invocationId, origin, body: 'held' })
    await flush()

    await run.broker.stop({ invocationId: run.invocationId, reason: 'test teardown' })
    await flush()

    expect(terminalsFor(run.events, steered.submissionId)).toEqual(['submission.cancelled'])
    expect(inputRejectedFor(run.events, steered.submissionId)).toHaveLength(0)
    expect(run.controller.steeredInputs).toHaveLength(0)
  })
})

describe('T-13689 caller-minted submissionId', () => {
  test('a repeat with the same id and body returns the original reply and delivers once', async () => {
    const run = await setup('inv_one_door_idempotent')
    const request = {
      invocationId: run.invocationId,
      submissionId: 'hrc-minted-1',
      origin,
      body: 'once',
    }
    const first = await run.broker.steer(request)
    const repeat = await run.broker.steer({ ...request })
    await flush()

    expect(first).toEqual({ submissionId: 'hrc-minted-1', admission: 'admitted' })
    expect(repeat).toEqual(first)
    expect(eventsForSubmission(run.events, 'admission.requested', 'hrc-minted-1')).toHaveLength(1)
    expect(steeredIds(run.controller.inputs)).toEqual(['hrc-minted-1'])
    expect(terminalsFor(run.events, 'hrc-minted-1')).toEqual(['submission.executed'])
  })

  test('a repeat that arrives while the first is still held returns the same admission', async () => {
    const run = await setup('inv_one_door_idempotent_held')
    await run.broker.invoke({
      invocationId: run.invocationId,
      origin,
      body: 'guarded',
      turnPolicy: 'guarded',
    })
    await flush()
    const request = { invocationId: run.invocationId, submissionId: 'hrc-held', origin, body: 'b' }
    const first = await run.broker.steer(request)
    const repeat = await run.broker.steer(request)
    run.controller.completeActiveTurn()
    await flush()

    expect(repeat).toEqual(first)
    expect(steeredIds(run.controller.inputs).filter((id) => id === 'hrc-held')).toHaveLength(1)
    expect(terminalsFor(run.events, 'hrc-held')).toEqual(['submission.executed'])
  })

  test('the same id with a different body is refused invalid params', async () => {
    const run = await setup('inv_one_door_id_conflict')
    await run.broker.steer({
      invocationId: run.invocationId,
      submissionId: 'hrc-conflict',
      origin,
      body: 'first',
    })
    const conflict = run.broker.steer({
      invocationId: run.invocationId,
      submissionId: 'hrc-conflict',
      origin,
      body: 'second',
    })
    await expect(conflict).rejects.toBeInstanceOf(BrokerError)
    await expect(conflict).rejects.toMatchObject({ code: -32602 })
    await flush()
    expect(eventsForSubmission(run.events, 'admission.requested', 'hrc-conflict')).toHaveLength(1)
    expect(terminalsFor(run.events, 'hrc-conflict')).toEqual(['submission.executed'])
  })

  test('the id is accepted on every submission door', async () => {
    const run = await setup('inv_one_door_id_enqueue')
    const request = {
      invocationId: run.invocationId,
      submissionId: 'hrc-queued',
      origin,
      body: 'q',
    }
    const first = await run.broker.enqueue(request)
    expect(await run.broker.enqueue(request)).toEqual(first)
    await flush()
    expect(steeredIds(run.controller.inputs)).toEqual(['hrc-queued'])
  })
})
