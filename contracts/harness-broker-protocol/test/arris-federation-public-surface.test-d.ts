import type {
  ArrisApprovalResponder,
  ArrisControlOutcome,
  ArrisControlReceipt,
  ArrisFederationValidationIssue,
  ArrisFederationValidationResult,
  ArrisHostDescriptor,
  ArrisHostLifecycleOwner,
  ArrisInputIdentity,
  ArrisJournalRecord,
  ArrisKnownReadinessState,
  ArrisParticipantIdentity,
  ArrisPendingApproval,
} from '../src/index.js'
import type { validateArrisHostDescriptor } from '../src/index.js'

// T-08503 public consumer contract. Behavioral fixture coverage lives beside
// the Arris adapter and control client; this projection makes every exported
// wire symbol visible to the public-surface compatibility gate.
declare const contract: {
  lifecycleOwner: ArrisHostLifecycleOwner
  descriptor: ArrisHostDescriptor
  identity: ArrisInputIdentity
  outcome: ArrisControlOutcome
  receipt: ArrisControlReceipt
  journalRecord: ArrisJournalRecord
  // T-08522. The blocks arris added under an UNCHANGED `arris.host-descriptor/1`
  // -- T-08520's approval surface and T-08521's ledger identity. They are part
  // of the published consumer contract for the same reason the rest is: a
  // driver reads them to tell "waiting on a person" from "wedged", and "can
  // answer mail" from "has no identity to answer as".
  approvalResponder: ArrisApprovalResponder
  pendingApproval: ArrisPendingApproval
  participant: ArrisParticipantIdentity
  readinessState: ArrisKnownReadinessState
  issue: ArrisFederationValidationIssue
  validation: ArrisFederationValidationResult<ArrisHostDescriptor>
  validator: typeof validateArrisHostDescriptor
}

const written = {
  outcome: 'written',
  neutral_turn_id: 'turn:1',
  codex_turn_id: null,
} satisfies ArrisControlOutcome

const notWritten = {
  outcome: 'not_written',
  code: 'host_busy',
  message: 'nothing was written',
  eligible_for_retry: true,
  requeue_as_input_permitted: false,
} satisfies ArrisControlOutcome

export type ArrisFederationPublicSurface = typeof contract
export const arrisFederationPublicSurfaceProjection = { written, notWritten }

// The descriptor's optional blocks are optional on the TYPE as well: a host
// published before arris T-08520/T-08521 carries neither, and a consumer that
// required them would refuse exactly the hosts this contract exists to admit.
const preT08520Control = {
  socket_path: '/tmp/control.sock',
  admission_classes: ['queue', 'steer'],
  unsupported_classes: ['interrupt', 'preempt'],
} satisfies ArrisHostDescriptor['control']

const currentControl = {
  ...preT08520Control,
  approval_responder: 'attached_client',
  pending_approvals: [{ class: 'command_execution', codex_turn_id: 'turn:9', offered_at_ms: 1 }],
  mail_reply: true,
} satisfies ArrisHostDescriptor['control']

// `null` is the identity-less host stating so, which is not the same as the
// block being absent: absent means a host older than the field.
const identityLess = { participant: null } satisfies NonNullable<ArrisHostDescriptor['identity']>
const identified = {
  participant: { principal_ref: 'agent:arris', scope_ref: 'arris@arris:primary' },
} satisfies NonNullable<ArrisHostDescriptor['identity']>

const awaitingApproval = 'awaiting_approval' satisfies ArrisKnownReadinessState

export const arrisHostDescriptorAdditiveProjection = {
  preT08520Control,
  currentControl,
  identityLess,
  identified,
  awaitingApproval,
}
