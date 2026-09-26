import type {
  InvocationCurrentTurnSummary,
  InvocationInspectionSummary,
  InvocationLifecycleView,
  InvocationLivenessView,
  InvocationState,
} from 'spaces-harness-broker-protocol'
import type { InspectionSummaryOptions, Invocation } from './invocation-model'

// ---------------------------------------------------------------------------
// Inspection read-model (T-01851) — ONE shared summary builder consumed by
// status(), snapshot/buildSnapshot, and listInvocations so they cannot drift.
// ---------------------------------------------------------------------------
function inferDriverHealth(
  state: InvocationState
): 'unknown' | 'healthy' | 'degraded' | 'unresponsive' | 'exited' {
  switch (state) {
    case 'ready':
    case 'turn_active':
      return 'healthy'
    case 'stopping':
      return 'degraded'
    case 'exited':
    case 'failed':
    case 'disposed':
      return 'exited'
    default:
      return 'unknown'
  }
}

function isProcessAlive(state: InvocationState): boolean {
  return state !== 'exited' && state !== 'failed' && state !== 'disposed'
}

/** Live-state retention blockers (which conditions hold off idle retirement). */
function computeRetentionBlockers(
  inv: Invocation
): Array<'active-turn' | 'pending-input' | 'pending-permission' | 'not-ready'> {
  const blockers: Array<'active-turn' | 'pending-input' | 'pending-permission' | 'not-ready'> = []
  if (inv.currentTurnId !== undefined) blockers.push('active-turn')
  if (inv.pending.length > 0) blockers.push('pending-input')
  if (inv.pendingPermissions.size > 0) blockers.push('pending-permission')
  if (inv.state === 'starting' || inv.state === 'stopping') blockers.push('not-ready')
  return blockers
}

function buildLifecycleView(inv: Invocation): InvocationLifecycleView | undefined {
  const overlay = inv.lifecycleOverlay
  if (overlay === undefined && inv.terminalReason === undefined) {
    return undefined
  }

  const blockedBy = computeRetentionBlockers(inv)
  const retention: InvocationLifecycleView['retention'] = {
    mode: overlay?.retention.mode ?? 'unknown',
  }
  if (overlay?.retention.mode === 'idle-ttl') {
    const { idleTtlMs } = overlay.retention
    retention.idleTtlMs = idleTtlMs
    const idleSince = inv.lastActivityAt
    if (idleSince !== undefined) {
      retention.idleSince = idleSince
      // computedRetireAt is only meaningful while nothing blocks retirement.
      if (blockedBy.length === 0) {
        retention.computedRetireAt = new Date(Date.parse(idleSince) + idleTtlMs).toISOString()
      }
    }
  }
  if (blockedBy.length > 0) {
    retention.blockedBy = blockedBy
  }

  const harnessRecovery: InvocationLifecycleView['harnessRecovery'] = {
    mode: overlay?.harnessRecovery.mode ?? 'unknown',
  }
  if (inv.currentHarnessGeneration !== undefined) {
    harnessRecovery.currentGeneration = inv.currentHarnessGeneration
  }

  const turnRetry: InvocationLifecycleView['turnRetry'] = {
    mode: overlay?.turnRetry.mode ?? 'unknown',
  }
  if (inv.currentTurnAttempt !== undefined) {
    turnRetry.currentAttempt = inv.currentTurnAttempt
  }

  const view: InvocationLifecycleView = { retention, harnessRecovery, turnRetry }
  if (overlay !== undefined) {
    view.policyId = overlay.policyId
    view.policyHash = overlay.policyHash
  }
  if (inv.terminalReason !== undefined) {
    view.terminalReason = inv.terminalReason
  }
  return view
}

function buildCurrentTurn(inv: Invocation): InvocationCurrentTurnSummary | undefined {
  if (inv.currentTurnId === undefined) return undefined
  const turn: InvocationCurrentTurnSummary = {
    turnId: inv.currentTurnId,
    startedAt: inv.currentTurnStartedAt ?? inv.lastActivityAt ?? inv.startedAt ?? '',
  }
  if (inv.currentInputId !== undefined) turn.inputId = inv.currentInputId
  if (inv.currentTurnAttempt !== undefined) turn.attempt = inv.currentTurnAttempt
  return turn
}

/**
 * Cached liveness view. This phase advertises liveness:'cached' only, so even
 * a probeLiveness request answers from projected facts with mode:'cached' (it
 * never issues tmux/process probes it cannot truthfully perform).
 */
function buildLivenessView(inv: Invocation): InvocationLivenessView {
  const driverHealth = inv.driver.runtimeHealth?.()
  return {
    mode: 'cached',
    checkedAt: inv.lastActivityAt ?? inv.startedAt ?? '',
    driver: driverHealth ?? { state: inferDriverHealth(inv.state) },
    process: {
      brokerPid: process.pid,
      ...(inv.childPid !== undefined ? { childPid: inv.childPid } : {}),
      alive: isProcessAlive(inv.state),
      ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
      ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
    },
  }
}

export function buildInspectionSummary(
  inv: Invocation,
  opts?: InspectionSummaryOptions
): InvocationInspectionSummary {
  const summary: InvocationInspectionSummary = {
    invocationId: inv.invocationId,
    state: inv.state,
    driver: inv.driver.kind,
    startedAt: inv.startedAt ?? inv.lastActivityAt ?? '',
    lastActivityAt: inv.lastActivityAt ?? inv.startedAt ?? '',
  }
  if (inv.turnsCompleted !== undefined) summary.turnsCompleted = inv.turnsCompleted
  if (inv.currentSeq !== undefined) summary.currentSeq = inv.currentSeq
  // currentTurn is always present (undefined when no turn is active) so a
  // cleared turn is observable as `currentTurn: undefined` rather than a
  // missing key after a terminal transition.
  summary.currentTurn = buildCurrentTurn(inv)
  const lifecycle = buildLifecycleView(inv)
  if (lifecycle !== undefined) summary.lifecycle = lifecycle
  if (inv.terminalSurface !== undefined) summary.terminalSurface = inv.terminalSurface
  if (opts?.probeLiveness === true || inv.driver.runtimeHealth?.().state === 'degraded') {
    summary.liveness = buildLivenessView(inv)
  }
  return summary
}
