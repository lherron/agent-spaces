import type { InvocationCapabilities } from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'

/**
 * Static capability descriptor for the muse-serve driver (T-08589).
 *
 * Every value is spike-gated: admission/turns/continuation/events from spikes
 * 2-4+6 (live schema + echo-turn probes, muse 1.3.0); preempt stays null
 * because atomicity was NOT proven live (spike 7 — no sustained running turn
 * without credentials); interrupt lands on the turn/interrupt ack; fileRefs
 * are accepted because the wire renders them as `@path` text mentions
 * (spike 4). No steerNeverStartsTurn (arris-only). No finalResponse block:
 * turn/start carries no output-schema field, so per-turn JSON Schema is
 * unsupported.
 */
export const MUSE_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['steer', 'queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'delivery-acknowledged',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  steer: { landingEvidence: 'transcript' },
  interrupt: { landingEvidence: 'ack' },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: true,
    fileRefs: true,
    queue: true,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'protocol',
  },
  continuation: {
    supported: true,
    provider: 'muse',
    keyKind: 'session',
  },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: true,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
  },
  permissions: {
    brokerToClientRequests: true,
    eventAudit: true,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}
