import { describe, expect, test } from 'bun:test'
import type {
  BrokerLifecyclePolicyOverlay,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  HarnessInvocationSpec,
  InvocationInput,
  InvocationInspectionSummary,
  InvocationSnapshot,
  InvocationStatusResponse,
} from 'spaces-harness-broker-protocol'
import { conservativeDefaultLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import type { Driver, DriverContext } from '../src/drivers/driver'
import { createNoopDriver } from '../src/drivers/noop-driver'
import { createEventLedger } from '../src/event-ledger'
import { noopCapabilities, noopSpec } from './helpers'

type InspectionBroker = ReturnType<typeof createBroker> & {
  listInvocations(req: BrokerListInvocationsRequest): Promise<BrokerListInvocationsResponse>
}

const summaryKeys = [
  'invocationId',
  'state',
  'driver',
  'startedAt',
  'lastActivityAt',
  'currentTurn',
  'currentSeq',
  'lifecycle',
  'liveness',
  'terminalSurface',
] as const satisfies readonly (keyof InvocationInspectionSummary)[]

const inspectionFields = (
  value: InvocationInspectionSummary | InvocationStatusResponse | InvocationSnapshot
) => {
  const fields: Partial<InvocationInspectionSummary> = {}
  for (const key of summaryKeys) {
    if (key in value) {
      fields[key] = value[key] as never
    }
  }
  return fields
}

const userInput = (inputId: string): InvocationInput => ({
  inputId,
  kind: 'user',
  content: [{ type: 'text', text: 'go' }],
})

const testSpec = (invocationId: string): HarnessInvocationSpec => ({
  ...noopSpec({
    invocationId,
    harness: { frontend: 'inspection', provider: 'test', driver: 'inspection-driver' },
    process: {
      command: 'inspection-driver',
      args: [],
      cwd: process.cwd(),
      harnessTransport: { kind: 'pipes' },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'inspection-driver' },
  }),
})

const tickingClock = (start = Date.parse('2026-06-03T20:00:00.000Z')) => {
  let ticks = 0
  return () => new Date(start + ticks++ * 1000)
}

const createInspectionDriver = (): Driver => {
  let ctx: DriverContext | undefined
  let activeInput: InvocationInput | undefined
  let activeTurnId: string | undefined

  return {
    kind: 'inspection-driver',
    version: 'test',
    capabilities: () => ({
      ...noopCapabilities,
      input: { ...noopCapabilities.input, queue: true },
    }),
    start: async (_spec, driverCtx) => {
      ctx = driverCtx
      ctx.emit('harness.started', {
        generation: 2,
        mode: 'initial',
        mechanism: 'direct-child',
        pid: 4321,
      })
      return { ok: true }
    },
    applyInputNow: async (input) => {
      if (ctx === undefined) throw new Error('driver not started')
      activeInput = input
      activeTurnId = 'turn_inspect_1'
      ctx.emit(
        'turn.started',
        { turnId: activeTurnId, inputId: input.inputId, turnAttempt: 3 },
        {
          turnId: activeTurnId,
          inputId: input.inputId,
          harnessGeneration: 2,
          turnAttempt: 3,
        }
      )
      return { turnId: activeTurnId }
    },
    interrupt: async () => ({ accepted: false, effect: 'unsupported' }),
    stop: async () => {
      if (ctx !== undefined) {
        ctx.emit('invocation.exited', { exitCode: 17, signal: null })
      }
      activeInput = undefined
      activeTurnId = undefined
      return { accepted: true, state: 'exited' }
    },
    dispose: async () => {
      void activeInput
      activeTurnId = undefined
      ctx = undefined
    },
  }
}

describe('broker inspection read model (T-01851 red)', () => {
  test('broker.listInvocations returns the active invocation and includeDisposed gates disposed rows', async () => {
    // T-01851: the broker has a single-invocation read model today. Disposed
    // invocations must be hidden by default so dashboards do not treat old rows
    // as live work, but includeDisposed keeps them inspectable for postmortems.
    const broker = createBroker({
      drivers: [createNoopDriver()],
      now: () => new Date('2026-06-03T20:00:00.000Z'),
    }) as InspectionBroker

    await expect(broker.listInvocations({})).resolves.toEqual({ invocations: [] })

    await broker.start({ spec: noopSpec({ invocationId: 'inv_list' }) })
    await expect(broker.listInvocations({})).resolves.toMatchObject({
      invocations: [
        {
          invocationId: 'inv_list',
          state: 'ready',
          driver: 'noop-driver',
          startedAt: '2026-06-03T20:00:00.000Z',
          lastActivityAt: '2026-06-03T20:00:01.000Z',
        },
      ],
    })

    await broker.stop({ invocationId: 'inv_list' })
    await broker.dispose({ invocationId: 'inv_list' })

    await expect(broker.listInvocations({})).resolves.toEqual({ invocations: [] })
    await expect(broker.listInvocations({ includeDisposed: true })).resolves.toMatchObject({
      invocations: [{ invocationId: 'inv_list', state: 'disposed' }],
    })
  })

  test('status, snapshot, and listInvocations expose identical inspection summary fields', async () => {
    // T-01851 drift guard: status(), snapshot/buildSnapshot(), and
    // listInvocations() must share one buildInspectionSummary helper. If any
    // surface assembles these fields independently, this test should catch it.
    const broker = createBroker({
      drivers: [createInspectionDriver()],
      eventLedger: createEventLedger(),
      now: tickingClock(),
    }) as InspectionBroker

    await broker.start(
      { spec: testSpec('inv_drift') },
      undefined,
      undefined,
      conservativeDefaultLifecyclePolicyOverlay('policy_inspection_drift')
    )
    await broker.input({ invocationId: 'inv_drift', input: userInput('input_drift') })

    const status = await broker.status({ invocationId: 'inv_drift', probeLiveness: true })
    const snapshot = await broker.snapshot({ invocationId: 'inv_drift', probeLiveness: true })
    const listed = await broker.listInvocations({ probeLiveness: true })
    const [summary] = listed.invocations

    expect(summary).toBeDefined()
    expect(inspectionFields(status)).toEqual(summary)
    expect(inspectionFields(snapshot)).toEqual(summary)
  })

  test('applyEventState projects timestamps, lifecycle, current turn, generation, attempt, and terminal facts', async () => {
    // T-01851: inspection is a projection over the central event path. The
    // values below come from different events, so this fails unless every event
    // updates the read model rather than status reading ad hoc state.
    const policy: BrokerLifecyclePolicyOverlay = conservativeDefaultLifecyclePolicyOverlay(
      'policy_inspection_projection'
    )
    const broker = createBroker({
      drivers: [createInspectionDriver()],
      now: tickingClock(),
    }) as InspectionBroker

    await broker.start({ spec: testSpec('inv_projection') }, undefined, undefined, policy)
    await broker.input({ invocationId: 'inv_projection', input: userInput('input_projection') })

    await expect(broker.status({ invocationId: 'inv_projection' })).resolves.toMatchObject({
      invocationId: 'inv_projection',
      state: 'turn_active',
      driver: 'inspection-driver',
      startedAt: '2026-06-03T20:00:00.000Z',
      lastActivityAt: '2026-06-03T20:00:04.000Z',
      currentSeq: 5,
      currentTurn: {
        turnId: 'turn_inspect_1',
        inputId: 'input_projection',
        startedAt: '2026-06-03T20:00:04.000Z',
        attempt: 3,
      },
      lifecycle: {
        policyId: policy.policyId,
        policyHash: policy.policyHash,
        retention: { mode: 'keep-alive' },
        harnessRecovery: { mode: 'none', currentGeneration: 2 },
        turnRetry: { mode: 'none', currentAttempt: 3 },
      },
      process: { pid: 4321 },
    })

    await broker.stop({ invocationId: 'inv_projection' })

    await expect(broker.status({ invocationId: 'inv_projection' })).resolves.toMatchObject({
      state: 'exited',
      lastActivityAt: '2026-06-03T20:00:06.000Z',
      currentSeq: 7,
      currentTurn: undefined,
      lifecycle: { terminalReason: 'exited' },
      process: { pid: 4321, exitCode: 17, signal: null },
    })
  })

  test('eventsSince type filter preserves full-ledger currentSeq and retentionFloorSeq', async () => {
    // T-01851: filtering affects only the returned events. currentSeq and the
    // retention floor still describe the full ledger so reconnecting clients can
    // advance safely past event types they did not ask to render.
    const eventLedger = createEventLedger()
    const broker = createBroker({
      drivers: [createInspectionDriver()],
      eventLedger,
      now: tickingClock(),
    })

    await broker.start({ spec: testSpec('inv_events_filter') })
    await broker.input({ invocationId: 'inv_events_filter', input: userInput('input_filter') })
    await broker.ackEvents({
      invocationId: 'inv_events_filter',
      throughSeq: 3,
      controllerInstanceId: 'controller_filter',
    })
    await eventLedger.prune({ activeInvocationIds: [] })

    const filtered = await broker.eventsSince({
      invocationId: 'inv_events_filter',
      afterSeq: 3,
      types: ['turn.started'],
    })

    expect(filtered.events.map((event) => event.type)).toEqual(['turn.started'])
    expect(filtered.currentSeq).toBe(4)
    expect(filtered.retentionFloorSeq).toBe(3)
  })

  test('cached liveness is reported honestly, including when probeLiveness is requested', async () => {
    // T-01851: this phase only advertises cached liveness. A probe request must
    // not pretend to perform active tmux/process probing when the invocation can
    // only answer from projected facts.
    const broker = createBroker({
      drivers: [createInspectionDriver()],
      now: tickingClock(),
    }) as InspectionBroker

    await broker.start({ spec: testSpec('inv_liveness') })

    await expect(broker.listInvocations({ probeLiveness: true })).resolves.toMatchObject({
      invocations: [
        {
          invocationId: 'inv_liveness',
          liveness: {
            mode: 'cached',
            checkedAt: expect.any(String),
            driver: { state: 'healthy' },
            process: { brokerPid: process.pid, childPid: 4321, alive: true },
          },
        },
      ],
    })

    await expect(
      broker.status({ invocationId: 'inv_liveness', probeLiveness: true })
    ).resolves.toMatchObject({
      liveness: { mode: 'cached' },
    })
  })
})
