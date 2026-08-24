import type { InputId } from 'spaces-harness-broker-protocol'

export type BrokerInputKind = 'user' | 'steer' | 'append_context'

export type BrokerBusyInputPolicy =
  | { whenBusy: 'reject' }
  | { whenBusy: 'queue'; maxDepth: number }
  | { whenBusy: 'interrupt_then_apply'; graceMs: number; enabled: false }

export type BrokerInputPolicy = {
  readyInput: 'start-turn'
  busy: BrokerBusyInputPolicy
  supportedKinds: BrokerInputKind[]
  attachmentPolicy: {
    localImages: boolean
    fileRefs: boolean
  }
}

export type BrokerInputRuntimeState = {
  policy: BrokerInputPolicy
  pendingDepth: number
  lastInputId?: InputId | undefined
  lastDisposition?: 'started' | 'queued' | 'rejected' | undefined
}

export const DEFAULT_CODEX_BROKER_INPUT_POLICY: BrokerInputPolicy = {
  readyInput: 'start-turn',
  busy: { whenBusy: 'reject' },
  supportedKinds: ['user'],
  attachmentPolicy: { localImages: true, fileRefs: false },
}
