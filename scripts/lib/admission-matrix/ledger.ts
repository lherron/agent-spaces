/**
 * Admission conformance matrix — LEDGER ASSERTION ENGINE (T-07860).
 *
 * Every assertion here reads the broker event ledger (plus the broker's own
 * `turn.manifest` / `queue.list` read models) and NOTHING else: no harness
 * JSONL, no tmux pane capture. The ledger is the contract surface
 * (hcs T-07843 §3.2 / §6), so an assertion that needed a transcript or a pane
 * would be proving something the contract does not promise.
 */
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

export type Verdict = 'PASS' | 'FAIL' | 'REJECT-OK'

export type Check = { id: string; ok: boolean; detail: string; evidence?: unknown }

export const TERMINAL_TURN_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.interrupted'])

/**
 * The complete terminal-disposition vocabulary of T-07843 §3.2. Exactly one of
 * these must exist per submission.
 */
export const SUBMISSION_TERMINALS = new Set([
  'submission.executed',
  'submission.absorbed',
  'submission.rejected',
  'submission.expired',
  'submission.cancelled',
])

function payload(event: InvocationEventEnvelope): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>
}

function stringField(event: InvocationEventEnvelope, key: string): string | undefined {
  const value = payload(event)[key]
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

/** Every event in the slice whose payload names one of these submission ids. */
export function forSubmissions(
  slice: InvocationEventEnvelope[],
  submissionIds: readonly string[]
): InvocationEventEnvelope[] {
  const wanted = new Set(submissionIds)
  return slice.filter((event) => {
    const id = stringField(event, 'submissionId')
    return id !== undefined && wanted.has(id)
  })
}

/** Terminal disposition observed for each submission id, in ledger order. */
export function terminalsBySubmission(
  slice: InvocationEventEnvelope[]
): Map<string, InvocationEventEnvelope[]> {
  const map = new Map<string, InvocationEventEnvelope[]>()
  for (const event of slice) {
    if (!SUBMISSION_TERMINALS.has(event.type)) continue
    const id = stringField(event, 'submissionId')
    if (id === undefined) continue
    map.set(id, [...(map.get(id) ?? []), event])
  }
  return map
}

/**
 * §9 assertion 1 — EXACTLY ONE terminal disposition per submission, and the
 * `submissionId` correlates the door call to it.
 *
 * This is unconditional now that the admission API mints the id at the door:
 * every admitted submission owes a terminal, and a rejected one owes exactly
 * the `submission.rejected` the broker already emitted. A driver that produces
 * none is a red cell, not an exemption.
 */
export function checkOneDispositionPerSubmission(
  slice: InvocationEventEnvelope[],
  submissionIds: readonly string[]
): Check {
  const terminals = terminalsBySubmission(slice)
  const missing = submissionIds.filter((id) => (terminals.get(id) ?? []).length === 0)
  const duplicated = submissionIds
    .map((id) => ({ id, events: terminals.get(id) ?? [] }))
    .filter((entry) => entry.events.length > 1)
  if (missing.length > 0) {
    return {
      id: 'one-disposition-per-submission',
      ok: false,
      detail: `${missing.length} of ${submissionIds.length} submission(s) reached NO terminal disposition: ${missing.join(', ')}`,
      evidence: excerpt(
        slice.filter(
          (event) => event.type.startsWith('submission.') || event.type.startsWith('admission.')
        )
      ),
    }
  }
  if (duplicated.length > 0) {
    return {
      id: 'one-disposition-per-submission',
      ok: false,
      detail: `${duplicated.length} submission(s) carry more than one terminal disposition`,
      evidence: duplicated.map((entry) => ({
        submissionId: entry.id,
        types: entry.events.map((event) => event.type),
      })),
    }
  }
  return {
    id: 'one-disposition-per-submission',
    ok: true,
    detail: submissionIds
      .map((id) => `${id}->${(terminals.get(id) ?? []).map((event) => event.type).join('')}`)
      .join(', '),
  }
}

/**
 * §9 assertion 2 — bracket facts follow the driver's declaration
 * (`capabilities.bracketMintingMode`, T-07849 rev 9 / T-07843 §5 layer 1).
 *
 * `harness-evidence`  → the broker must NOT synthesize a start from delivery:
 *                       no `turn.started{source:'broker-delivery'}` anywhere.
 *                       The bracket, when it comes, is evidence-sourced.
 * otherwise           → the delivery-minted bracket is RETAINED: a turn that
 *                       carried an own-turn submission has a `turn.started` on
 *                       the ledger. The retained event's `source` is
 *                       deliberately NOT asserted — the broker dedupes its
 *                       synthesized start against a driver-emitted one for the
 *                       same turn and whichever lands first wins.
 */
export function checkBracketMinting(
  slice: InvocationEventEnvelope[],
  bracketMintingMode: string,
  expectedOwnTurnIds: readonly string[]
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
  if (expectedOwnTurnIds.length === 0) {
    return {
      id: 'bracket-minting',
      ok: true,
      detail: `${bracketMintingMode}: no own turn expected in this cell`,
    }
  }
  const bracketed = new Set(
    starts
      .map((event) => stringField(event, 'turnId'))
      .filter((id): id is string => id !== undefined)
  )
  const unbracketed = expectedOwnTurnIds.filter((turnId) => !bracketed.has(turnId))
  return unbracketed.length === 0
    ? {
        id: 'bracket-minting',
        ok: true,
        detail: `${bracketMintingMode}: every dispositioned own turn is bracketed (${expectedOwnTurnIds.join(', ')})`,
      }
    : {
        id: 'bracket-minting',
        ok: false,
        detail: `${bracketMintingMode} driver dispositioned submissions into turn(s) with no turn.started bracket: ${unbracketed.join(', ')}`,
        evidence: excerpt(starts),
      }
}

/**
 * §9 assertion 7 — the broker's `turn.manifest` read model lists EXACTLY the
 * submissions the ledger dispositioned into that turn.
 *
 * This is the one assertion with two independent sources: the event stream and
 * the manifest RPC. A manifest that merely echoed the ledger projection would
 * prove nothing, which is why the expected set is rebuilt from the events here
 * and compared against what the broker answers.
 */
export function checkTurnManifest(
  slice: InvocationEventEnvelope[],
  wholeRun: InvocationEventEnvelope[],
  manifests: ReadonlyMap<string, readonly string[]>,
  manifestErrors: ReadonlyMap<string, string> = new Map()
): Check {
  // Which turns THIS cell touched...
  const touched = new Set<string>()
  for (const event of slice) {
    const turnId = stringField(event, 'turnId') ?? event.turnId
    if (typeof turnId === 'string') touched.add(turnId)
  }
  // ...but the expected membership is rebuilt from the WHOLE runtime. A turn a
  // steer joins was STARTED by an earlier submission, whose disposition sits
  // before this cell's watermark; rebuilding from the slice alone would expect
  // only the joiner and report the legitimate starter as an extra. The manifest
  // names everyone who rode the turn, so the comparison must too.
  const expected = new Map<string, Set<string>>()
  for (const event of wholeRun) {
    if (event.type !== 'submission.executed' && event.type !== 'submission.absorbed') continue
    const turnId = stringField(event, 'turnId')
    const id = stringField(event, 'submissionId')
    if (turnId === undefined || id === undefined || !touched.has(turnId)) continue
    const entry = expected.get(turnId) ?? new Set<string>()
    entry.add(id)
    expected.set(turnId, entry)
  }
  const mismatches: unknown[] = []
  for (const [turnId, ids] of expected) {
    const reported = manifests.get(turnId)
    if (reported === undefined) {
      mismatches.push({
        turnId,
        problem: 'turn.manifest did not answer for a turn the ledger dispositioned into',
        error: manifestErrors.get(turnId) ?? '(no error recorded)',
      })
      continue
    }
    const reportedSet = new Set(reported)
    const missing = [...ids].filter((id) => !reportedSet.has(id))
    const extra = reported.filter((id) => !ids.has(id))
    if (missing.length > 0 || extra.length > 0) {
      mismatches.push({ turnId, ledger: [...ids], manifest: reported, missing, extra })
    }
  }
  return mismatches.length === 0
    ? {
        id: 'turn-manifest',
        ok: true,
        detail: `${expected.size} turn(s) agree between the ledger and turn.manifest`,
        evidence: [...expected].map(([turnId, ids]) => ({ turnId, submissionIds: [...ids] })),
      }
    : {
        id: 'turn-manifest',
        ok: false,
        detail: `${mismatches.length} turn(s) where turn.manifest disagrees with the ledger`,
        evidence: mismatches,
      }
}

/**
 * The ONE `capture.warning` raw kind mable's ruling #2 tolerates: a preempt
 * drain that dequeued an item for which no user row ever appeared. The item is
 * a REPORTED blocked-unknown, not a silent drop, and it is allowed at most once
 * and only with this exact signature. Every other warning still fails the
 * matrix loudly — that is the §9 behavior pin.
 */
const RULED_BLOCKED_UNKNOWN_KIND = 'claude.dequeue-without-user-row'

function isRuledBlockedUnknown(event: InvocationEventEnvelope): boolean {
  const raw = (event.payload as { raw?: unknown } | undefined)?.raw
  if (typeof raw !== 'object' || raw === null) return false
  const record = raw as Record<string, unknown>
  return (
    record['kind'] === RULED_BLOCKED_UNKNOWN_KIND &&
    typeof record['blockedSubmissionId'] === 'string' &&
    'dequeue' in record &&
    'observedUserRow' in record
  )
}

/**
 * §9 assertion 8 — zero `capture.warning` across the WHOLE runtime, with the
 * single ruled blocked-unknown exception above.
 */
export function checkNoCaptureWarning(wholeRun: InvocationEventEnvelope[]): Check {
  const warnings = wholeRun.filter((event) => event.type === 'capture.warning')
  const blockedUnknown = warnings.filter(isRuledBlockedUnknown)
  const others = warnings.filter((event) => !isRuledBlockedUnknown(event))
  if (others.length > 0) {
    return {
      id: 'zero-capture-warning',
      ok: false,
      detail: `${others.length} capture.warning event(s) outside the ruled blocked-unknown signature`,
      evidence: excerpt(others),
    }
  }
  if (blockedUnknown.length > 1) {
    return {
      id: 'zero-capture-warning',
      ok: false,
      detail: `${blockedUnknown.length} ruled blocked-unknown warnings; the ruling allows AT MOST ONE`,
      evidence: excerpt(blockedUnknown),
    }
  }
  return {
    id: 'zero-capture-warning',
    ok: true,
    detail:
      blockedUnknown.length === 0
        ? 'no capture.warning across the whole runtime'
        : `no capture.warning except the one ruled blocked-unknown (${RULED_BLOCKED_UNKNOWN_KIND}), reported not swallowed`,
    ...(blockedUnknown.length > 0 ? { evidence: excerpt(blockedUnknown) } : {}),
  }
}

/** The decision ledger must record every admission decision (§6). */
export function checkDecisionLedger(
  slice: InvocationEventEnvelope[],
  submissionIds: readonly string[]
): Check {
  const requested = new Set(
    slice
      .filter((event) => event.type === 'admission.requested')
      .map((event) => stringField(event, 'submissionId'))
  )
  const decided = new Set(
    slice
      .filter((event) => event.type === 'admission.admitted' || event.type === 'admission.rejected')
      .map((event) => stringField(event, 'submissionId'))
  )
  const missingRequest = submissionIds.filter((id) => !requested.has(id))
  const missingDecision = submissionIds.filter((id) => !decided.has(id))
  return missingRequest.length === 0 && missingDecision.length === 0
    ? {
        id: 'decision-ledger',
        ok: true,
        detail: `admission.requested + admitted/rejected recorded for all ${submissionIds.length} submission(s)`,
      }
    : {
        id: 'decision-ledger',
        ok: false,
        detail: `missing admission.requested for [${missingRequest.join(', ')}], missing admitted/rejected for [${missingDecision.join(', ')}]`,
        evidence: excerpt(slice.filter((event) => event.type.startsWith('admission.'))),
      }
}

export function verdictOf(checks: Check[], rejected: boolean): Verdict {
  if (checks.some((check) => !check.ok)) return 'FAIL'
  return rejected ? 'REJECT-OK' : 'PASS'
}
