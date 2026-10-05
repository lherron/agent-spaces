import type {
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationInput,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createTestDriver } from '../../src/testing/test-driver'
import { testDriverSpec } from '../helpers'
import { invocationIdFrom } from '../ids'

/** Let the broker's microtask/timer-driven admission drain settle. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

export const origin: SubmissionOrigin = {
  principalRef: 'agent:test',
  scopeRef: 'test@agent-spaces',
}

/** A started broker over one steer-capable test driver, recording every event. */
export async function setup(
  rawInvocationId: string,
  options: Parameters<typeof createTestDriver>[0] = {},
  brokerOptions: { authorizeSubmission?: () => boolean } = {}
) {
  const invocationId = invocationIdFrom(rawInvocationId)
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

export function eventsFor<K extends InvocationEventType>(
  events: InvocationEventEnvelope[],
  type: K
): InvocationEventEnvelope<K>[] {
  return events.filter((event): event is InvocationEventEnvelope<K> => event.type === type)
}

/** The submission an event is about, for payload families that carry one. */
export function submissionIdOf(event: InvocationEventEnvelope): string | undefined {
  return 'submissionId' in event.payload ? event.payload.submissionId : undefined
}

/** Events of one type about one submission. */
export function eventsForSubmission<K extends InvocationEventType>(
  events: InvocationEventEnvelope[],
  type: K,
  submissionId: string
): InvocationEventEnvelope<K>[] {
  return eventsFor(events, type).filter((event) => submissionIdOf(event) === submissionId)
}

/** Codex correlates a pending own turn by the exact prompt text it observed. */
export const codexPromptCorrelation = (
  observed: { prompt?: string | undefined },
  pending: InvocationInput
): boolean =>
  observed.prompt ===
  pending.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
