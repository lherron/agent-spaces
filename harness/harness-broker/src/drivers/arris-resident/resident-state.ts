import type { InputId } from 'spaces-harness-broker-protocol'

/**
 * The correlation and admission facts the receipt ledger, the journal
 * normalizer and the driver lifecycle all read and write. Receipts bind broker
 * inputs to the host's neutral turns; the journal reads those bindings to
 * attribute turns and releases the retry hold a refused write set.
 */
export interface ArrisResidentState {
  /** The neutral turn the host is running now, as last learned from a receipt or the journal. */
  currentNeutralTurnId: string | undefined
  /** A retry-eligible refusal is outstanding; reported as one harness-local queued input. */
  retryHold: boolean
  healthReason: string | undefined
  readonly brokerInputByHostInput: Map<string, InputId>
  readonly inputByNeutralTurn: Map<string, InputId>
  readonly neutralByCodexTurn: Map<string, string>
}

export function createResidentState(): ArrisResidentState {
  return {
    currentNeutralTurnId: undefined,
    retryHold: false,
    healthReason: undefined,
    brokerInputByHostInput: new Map(),
    inputByNeutralTurn: new Map(),
    neutralByCodexTurn: new Map(),
  }
}

/** The neutral turn a Codex turn id maps to, else the turn the host is running now. */
export function neutralTurnFor(
  state: ArrisResidentState,
  codexTurnId: string | undefined
): string | undefined {
  return (
    (codexTurnId === undefined ? undefined : state.neutralByCodexTurn.get(codexTurnId)) ??
    state.currentNeutralTurnId
  )
}
