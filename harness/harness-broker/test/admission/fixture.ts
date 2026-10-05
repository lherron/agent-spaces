import type {
  InvocationEventEnvelope,
  InvocationInput,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createTestDriver } from '../../src/testing/test-driver'
import { testDriverSpec } from '../helpers'

/** Let the broker's microtask/timer-driven admission drain settle. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

export const origin: SubmissionOrigin = {
  principalRef: 'agent:test',
  scopeRef: 'test@agent-spaces',
}

/** A started broker over one steer-capable test driver, recording every event. */
export async function setup(
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
  await broker.start({ spec: testDriverSpec(invocationId) })
  return { broker, controller, driver, events, invocationId }
}

export function eventsFor(
  events: InvocationEventEnvelope[],
  type: InvocationEventEnvelope['type']
) {
  return events.filter((event) => event.type === type)
}

/** Events of one type about one submission. */
export function eventsForSubmission(
  events: InvocationEventEnvelope[],
  type: InvocationEventEnvelope['type'],
  submissionId: string
) {
  return eventsFor(events, type).filter(
    (event) => (event.payload as { submissionId?: unknown }).submissionId === submissionId
  )
}

/** Codex correlates a pending own turn by the exact prompt text it observed. */
export const codexPromptCorrelation = (
  observed: { prompt?: string | undefined },
  pending: InvocationInput
): boolean =>
  observed.prompt ===
  pending.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
