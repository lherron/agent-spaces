import type {
  ApplyInputResult,
  Driver,
  DriverContext,
  DriverStartResult,
} from 'spaces-harness-broker'
import { BrokerError } from 'spaces-harness-broker'
import type {
  EvidenceAuthorityMatrix,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'

export const AGENT_HARNESS_TMUX_DRIVER_KIND = 'agent-harness-tmux'

/**
 * Earendil 0.86.1 calls `process.exit()` from InteractiveMode shutdown and
 * fatal paths.  A release worker cannot host that implementation: it would
 * let an operator leave terminate the standard broker endpoint and it disposes
 * the runtime outside broker lifecycle authority.
 */
export const AGENT_HARNESS_TMUX_EMBEDDED_LIFECYCLE_REQUIRED =
  'agent-harness-tmux is unavailable: Earendil 0.86.1 InteractiveMode lacks a non-exiting embedded lifecycle; clean leave calls process.exit and disposes the runtime'

const CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'delivery-asserted',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: 'atomic' },
  steer: { landingEvidence: null },
  interrupt: { landingEvidence: 'ack' },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: true,
  },
  turns: { concurrency: 'single', interrupt: 'protocol' },
  continuation: { supported: true, keyKind: 'session' },
  events: { assistantDeltas: true, toolCalls: true, usage: true, diagnostics: true },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    liveness: 'cached',
    driverAttachExistingSurface: false,
  },
  permissions: { brokerToClientRequests: false, eventAudit: true },
  finalResponse: { jsonSchema: true, perTurn: true, strict: true, parsedResult: false },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

const AUTHORITY: EvidenceAuthorityMatrix = {
  'invocation-lifecycle': 'broker',
  'harness-lifecycle': 'broker',
  continuation: 'broker',
  'input-admission': 'broker',
  'submission-disposition': 'broker',
  'turn-bracket': 'broker',
  'turn-supervision': 'broker',
  conversation: 'broker',
  tool: 'broker',
  usage: 'broker',
  permission: 'broker',
  diagnostic: 'broker',
  'terminal-surface': 'broker',
  'provider-artifact': 'broker',
}

/**
 * Register the interactive identity in the release worker without retaining
 * a retired private relay. The driver is intentionally
 * unavailable, so inventory and start refusal report the exact missing
 * upstream capability instead of advertising a route that exits its broker.
 */
export function createAgentHarnessTmuxDriver(): Driver {
  const unavailable = (): BrokerError =>
    new BrokerError(
      BrokerErrorCode.DriverUnavailable,
      AGENT_HARNESS_TMUX_EMBEDDED_LIFECYCLE_REQUIRED
    )

  return {
    kind: AGENT_HARNESS_TMUX_DRIVER_KIND,
    version: '0.1.0',
    bracketMintingMode: 'delivery-asserted',
    evidenceAuthority: AUTHORITY,
    nativeSourceKind: 'provider-jsonrpc',
    preemptMode: 'atomic',
    steerLandingEvidence: null,
    interruptLandingEvidence: 'ack',
    unavailableReason: () => AGENT_HARNESS_TMUX_EMBEDDED_LIFECYCLE_REQUIRED,
    capabilities: () => CAPABILITIES,
    async start(_spec: HarnessInvocationSpec, _ctx: DriverContext): Promise<DriverStartResult> {
      throw unavailable()
    },
    async applyInputNow(_input: InvocationInput): Promise<ApplyInputResult> {
      throw unavailable()
    },
    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      throw unavailable()
    },
    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      return { accepted: true, state: 'exited' }
    },
    async dispose(): Promise<void> {},
  }
}
