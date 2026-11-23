import { CLAUDE_DESKTOP_PARTICIPANT_CLASS } from 'agent-spaces'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
  type InvocationCapabilities,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { Driver } from '../driver'
import { BROKER_ONLY_AUTHORITY } from '../evidence-authority'

const capabilities: InvocationCapabilities = {
  admission: { classes: [] },
  bracketMintingMode: 'observed',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  steer: { landingEvidence: null },
  interrupt: { landingEvidence: null },
  input: {
    user: false,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: false,
  },
  turns: { concurrency: 'single', interrupt: 'unsupported' },
  continuation: { supported: false },
  events: {
    assistantDeltas: false,
    toolCalls: false,
    usage: false,
    diagnostics: false,
    replay: true,
    ack: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    status: true,
    snapshot: true,
    eventsSince: true,
    eventTypeFilter: true,
    liveness: 'cached',
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

/** Attach an invocation to a desktop-owned session. Observation and delivery are separate. */
export function createClaudeDesktopDriver(sessionId: string): Driver {
  return {
    kind: CLAUDE_DESKTOP_PARTICIPANT_CLASS,
    version: '0.1.0',
    bracketMintingMode: 'observed',
    evidenceAuthority: BROKER_ONLY_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: null,
    steerLandingEvidence: null,
    interruptLandingEvidence: null,
    capabilities: () => capabilities,
    async start(spec) {
      if (!('sessionId' in spec.driver) || spec.driver['sessionId'] !== sessionId) {
        throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Claude Desktop session mismatch')
      }
      return { ok: true }
    },
    async applyInputNow() {
      throw new BrokerError(
        BrokerErrorCode.UnsupportedCapability,
        'Claude Desktop input is unavailable'
      )
    },
    async interrupt() {
      return {
        accepted: false,
        effect: 'unsupported',
        reason: 'desktop lifecycle is externally owned',
      }
    },
    async stop() {
      return { accepted: true, state: 'exited' }
    },
    async dispose() {},
  }
}
