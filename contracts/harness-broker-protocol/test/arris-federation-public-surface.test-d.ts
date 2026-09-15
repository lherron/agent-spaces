import type {
  ArrisControlOutcome,
  ArrisControlReceipt,
  ArrisFederationValidationIssue,
  ArrisFederationValidationResult,
  ArrisHostDescriptor,
  ArrisHostLifecycleOwner,
  ArrisInputIdentity,
  ArrisJournalRecord,
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
