import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { createTestDriver } from '../src/testing/test-driver'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const origin: SubmissionOrigin = { principalRef: 'agent:test', scopeRef: 'test@mobile' }

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

const text = (content: Array<{ type: string; text?: string }>) =>
  content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')

describe('T-07962 recorded Codex tmux wedge shape', () => {
  test('input-ID-less matching starts settle each submission and drain FIFO', async () => {
    const events: InvocationEventEnvelope[] = []
    const { driver, controller } = createTestDriver({
      supportsSteer: true,
      bracketMintingMode: 'harness-evidence',
      suppressTurnStarted: true,
      failPendingOwnTurnOnForeignTurn: true,
      correlatePendingOwnTurnStart: (observed, pending) =>
        observed.prompt !== undefined && observed.prompt === text(pending.content),
    })
    const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
    const invocationId = 'inv_t07962_codex_wedge'
    await broker.start({ spec: spec(invocationId) })

    const submissions = []
    submissions.push(
      await broker.enqueue({
        invocationId,
        origin,
        body: 'Does lab1 have cuda drivers included in template?',
      })
    )
    submissions.push(await broker.enqueue({ invocationId, origin, body: 'follow-up' }))
    submissions.push(await broker.enqueue({ invocationId, origin, body: 'third' }))
    await flush()

    const prompts = ['Does lab1 have cuda drivers included in template?', 'follow-up', 'third']
    for (let index = 0; index < prompts.length; index += 1) {
      expect(controller.inputs).toHaveLength(index + 1)
      const turnId = `01a06912-6ad3-75b0-abee-76cb297cde${index}` as const
      controller.emitRaw(
        'turn.started',
        { turnId, sessionId: '01a067a6', prompt: prompts[index] },
        { turnId }
      )
      controller.emitRaw(
        'turn.completed',
        { turnId, status: 'completed', finalOutput: `answer ${index + 1}` },
        { turnId }
      )
      await flush()
    }

    expect(
      events.filter((event) => event.type === 'input.accepted').map((event) => event.inputId)
    ).toEqual(submissions.map((submission) => submission.submissionId))
    expect(
      events
        .filter((event) => event.type === 'submission.executed')
        .map((event) => event.payload.submissionId)
    ).toEqual(submissions.map((submission) => submission.submissionId))
    expect(await broker.queueList({ invocationId })).toMatchObject({ entries: [] })
    expect((await broker.seatProbe({ invocationId })).seat).toEqual({ state: 'idle' })
  })
})
