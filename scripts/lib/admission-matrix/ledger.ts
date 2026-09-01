/**
 * Admission conformance matrix — LEDGER ASSERTION ENGINE (T-07860).
 *
 * Every assertion in this file reads the broker event ledger and NOTHING else:
 * no harness JSONL, no tmux pane capture. The ledger is the contract surface
 * (hcs T-07843 §3.2/§6), so an assertion that needed a transcript or a pane
 * would be proving something the contract does not promise.
 */
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import type { BracketMintingMode } from '../../../harness/harness-broker/src/drivers/driver'

export type Verdict = 'PASS' | 'FAIL' | 'REJECT-OK'

export type Check = { id: string; ok: boolean; detail: string; evidence?: unknown }

export const TERMINAL_TURN_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.interrupted'])

/** Terminal submission dispositions in the CURRENT protocol revision. */
export const SUBMISSION_TERMINALS = new Set([
  'submission.executed',
  'submission.absorbed',
  'submission.cancelled',
])

function payload(event: InvocationEventEnvelope): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>
}

function submissionId(event: InvocationEventEnvelope): string | undefined {
  const value = payload(event)['submissionId']
  return typeof value === 'string' ? value : undefined
}

export function excerpt(events: InvocationEventEnvelope[], limit = 24): unknown[] {
  return events.slice(0, limit).map((event) => ({
    seq: event.seq,
    type: event.type,
    turnId: event.turnId,
    inputId: event.inputId,
    payload: event.payload,
  }))
}

/**
 * Turn manifest projection: turnId → the submissions the ledger dispositioned
 * into it (T-07843 §3.2). Built ONLY from disposition events, so it is the
 * ledger's own answer to "who rode this turn".
 */
export function turnManifest(events: InvocationEventEnvelope[]): Map<string, string[]> {
  const manifest = new Map<string, string[]>()
  for (const event of events) {
    if (event.type !== 'submission.executed' && event.type !== 'submission.absorbed') continue
    const turnId = payload(event)['turnId']
    const id = submissionId(event)
    if (typeof turnId !== 'string' || id === undefined) continue
    const entries = manifest.get(turnId) ?? []
    entries.push(id)
    manifest.set(turnId, entries)
  }
  return manifest
}

/**
 * §9 assertion 1 — exactly one terminal disposition per submission.
 *
 * A driver whose bracket-minting declaration is `harness-evidence` runs the
 * T-07849 disposition mirror by construction (its brackets come from the same
 * transcript evidence the mirror reads), so a delivered submission that
 * produces NO disposition on such a driver is a red cell, not an exemption.
 * Drivers declaring `delivery-acknowledged` / `delivery-asserted` mint their
 * bracket at delivery and carry no mirror at this protocol revision; for them
 * the invariant is conditional — if dispositions appear at all, they must obey
 * the one-terminal rule.
 */
export function checkOneDispositionPerSubmission(
  slice: InvocationEventEnvelope[],
  bracketMintingMode: BracketMintingMode,
  deliveredSubmissions: number
): Check {
  const terminals = new Map<string, string[]>()
  for (const event of slice) {
    if (!SUBMISSION_TERMINALS.has(event.type)) continue
    const id = submissionId(event)
    if (id === undefined) continue
    terminals.set(id, [...(terminals.get(id) ?? []), event.type])
  }
  const duplicated = [...terminals.entries()].filter(([, types]) => types.length > 1)
  if (duplicated.length > 0) {
    return {
      id: 'one-disposition-per-submission',
      ok: false,
      detail: `${duplicated.length} submission(s) carry more than one terminal disposition`,
      evidence: duplicated.map(([id, types]) => ({ submissionId: id, types })),
    }
  }
  if (
    bracketMintingMode === 'harness-evidence' &&
    deliveredSubmissions > 0 &&
    terminals.size === 0
  ) {
    return {
      id: 'one-disposition-per-submission',
      ok: false,
      detail: `harness-evidence driver dispositioned none of ${deliveredSubmissions} delivered submission(s); no submission.* terminal on the ledger`,
      evidence: excerpt(
        slice.filter((e) => e.type.startsWith('input.') || e.type.startsWith('turn.'))
      ),
    }
  }
  return {
    id: 'one-disposition-per-submission',
    ok: true,
    detail: `${terminals.size} submission terminal(s), all unique`,
  }
}

/**
 * §9 assertion 2 — bracket facts follow the driver's declaration
 * (T-07849 rev 9 / T-07843 §5 layer 1).
 *
 * `harness-evidence`  → the broker must NOT synthesize a start from delivery:
 *                       no `turn.started{source:'broker-delivery'}` anywhere.
 *                       The bracket, when it comes, is evidence-sourced.
 * otherwise           → the delivery-minted bracket is RETAINED: the turn id
 *                       `applyInputNow` returned has a `turn.started` on the
 *                       ledger. The retained event's `source` is deliberately
 *                       NOT asserted — the broker dedupes its synthesized start
 *                       against a driver-emitted one for the same turn and
 *                       whichever lands first wins, so a driver-sourced start
 *                       for the delivered turn id satisfies the declaration
 *                       exactly as a `broker-delivery` one does.
 */
export function checkBracketMinting(
  slice: InvocationEventEnvelope[],
  bracketMintingMode: BracketMintingMode,
  expectOwnTurn: boolean,
  deliveredTurnId?: string | undefined
): Check {
  const starts = slice.filter((event) => event.type === 'turn.started')
  if (bracketMintingMode === 'harness-evidence') {
    const synthesized = starts.filter((event) => payload(event)['source'] === 'broker-delivery')
    return synthesized.length === 0
      ? {
          id: 'bracket-minting',
          ok: true,
          detail: `harness-evidence: no broker-delivery start synthesized (${starts.length} evidence-sourced start(s))`,
        }
      : {
          id: 'bracket-minting',
          ok: false,
          detail: `harness-evidence driver emitted ${synthesized.length} broker-delivery turn.started`,
          evidence: excerpt(synthesized),
        }
  }
  if (!expectOwnTurn) {
    return {
      id: 'bracket-minting',
      ok: true,
      detail: `${bracketMintingMode}: no own turn expected in this cell`,
    }
  }
  if (deliveredTurnId === undefined) {
    return {
      id: 'bracket-minting',
      ok: false,
      detail: `${bracketMintingMode} driver returned no turnId from delivery, so no bracket could be minted`,
      evidence: excerpt(
        slice.filter((e) => e.type.startsWith('turn.') || e.type.startsWith('input.'))
      ),
    }
  }
  const bracket = starts.find((event) => payload(event)['turnId'] === deliveredTurnId)
  return bracket !== undefined
    ? {
        id: 'bracket-minting',
        ok: true,
        detail: `${bracketMintingMode}: delivered turn ${deliveredTurnId} bracketed (source=${String(payload(bracket)['source'] ?? 'driver')})`,
      }
    : {
        id: 'bracket-minting',
        ok: false,
        detail: `${bracketMintingMode} driver's delivered turn ${deliveredTurnId} has no turn.started bracket`,
        evidence: excerpt(starts),
      }
}

/**
 * §9 assertion 7 — the manifest is well-founded: every turn a disposition names
 * has a bracket on the SAME ledger, and every manifest entry is unique.
 */
export function checkTurnManifest(
  slice: InvocationEventEnvelope[],
  wholeRun: InvocationEventEnvelope[]
): Check {
  const manifest = turnManifest(slice)
  const brackets = new Set(
    wholeRun
      .filter((event) => event.type === 'turn.started')
      .map((event) => payload(event)['turnId'])
      .filter((value): value is string => typeof value === 'string')
  )
  const orphans = [...manifest.keys()].filter((turnId) => !brackets.has(turnId))
  if (orphans.length > 0) {
    return {
      id: 'turn-manifest',
      ok: false,
      detail: `${orphans.length} turn(s) named by a disposition have no turn.started bracket`,
      evidence: orphans,
    }
  }
  const dupes = [...manifest.entries()].filter(([, ids]) => new Set(ids).size !== ids.length)
  if (dupes.length > 0) {
    return {
      id: 'turn-manifest',
      ok: false,
      detail: 'a submission appears twice in one turn manifest',
      evidence: dupes.map(([turnId, ids]) => ({ turnId, ids })),
    }
  }
  return {
    id: 'turn-manifest',
    ok: true,
    detail: `${manifest.size} turn(s) in manifest: ${JSON.stringify([...manifest.entries()])}`,
  }
}

/**
 * §9 assertion 8 — zero `capture.warning` across the WHOLE runtime. This is the
 * behavior-pin guard: a harness vocabulary change fails the matrix loudly
 * instead of silently misfiling attribution.
 */
export function checkNoCaptureWarning(wholeRun: InvocationEventEnvelope[]): Check {
  const warnings = wholeRun.filter((event) => event.type === 'capture.warning')
  return warnings.length === 0
    ? {
        id: 'zero-capture-warning',
        ok: true,
        detail: 'no capture.warning across the whole runtime',
      }
    : {
        id: 'zero-capture-warning',
        ok: false,
        detail: `${warnings.length} capture.warning event(s) on the runtime ledger`,
        evidence: excerpt(warnings),
      }
}

export function verdictOf(checks: Check[], rejected: boolean): Verdict {
  if (checks.some((check) => !check.ok)) return 'FAIL'
  return rejected ? 'REJECT-OK' : 'PASS'
}
