import { createCodexDesktopParticipantAdapter } from 'agent-spaces'
import {
  type JoinPrepareInput,
  attachParticipant,
  isHostBindingConflict,
  isIncarnationBoundElsewhere,
  isRedirect,
  isScopeOccupied,
  isScopeRetired,
  registerParticipant,
} from 'spaces-hrc-join-client'
import type { ParticipantAdapter } from 'spaces-runtime-contracts'
import {
  DESKTOP_AGENT_ID,
  DESKTOP_LANE_REF,
  desktopScopeRef,
  desktopSlotTokenSequence,
} from './desktop-project.js'

export type ScopeJoinInput = {
  hrcSocketPath: string
  projectId: string
  hostIncarnationId: string
  socketPath: string
  classId: string
  participantKey: string
  workspaceCwd: string
  preparation: JoinPrepareInput['preparation']
  expectedPredecessor?:
    | { hostIncarnationId: string; runtimeId: string; generation: number }
    | undefined
  scopeRef?: string | undefined
  adapter?: ParticipantAdapter | undefined
  maxSlots?: number | undefined
  resumeFromScope?: string | undefined
  onCandidateScope?: ((scopeRef: string) => void) | undefined
  /** Bound on each HRC register/attach exchange; a timeout throws like any transport failure. */
  requestTimeoutMs?: number | undefined
}

export type ScopeJoinOutcome =
  | {
      exit: 'joined'
      scopeRef: string
      registrationId: string
      attemptId: string
      attachEpoch: number
      runtimeId: string
      generation: number
      hostSessionId: string
    }
  | { exit: 'pending-hold'; scopeRef: string; reason: string; detail: string }
  | { exit: 'redirect'; scopeRef: string; reason: string; homeNodeId?: string | undefined }
  | { exit: 'not-prepared'; scopeRef: string; reason: string }
  | { exit: 'attach-refused'; scopeRef: string; reason: string; detail: string }
  | { exit: 'register-refused'; scopeRef: string; reason: string; detail: string }
  | { exit: 'scope-exhausted'; detail: string }

/**
 * The address our own incarnation already holds, when HRC names it in an
 * `participant_host_incarnation_bound_elsewhere` refusal. HRC checks the
 * incarnation binding before address occupancy, so a slot loop that restarts
 * at `primary-nova` can never reach its own held slot by advancing — it jumps
 * to the named address, where the same-incarnation register replays. This is
 * the fallback for the crash window the write-ahead record does not cover.
 */
function heldScopeFromIncarnationRefusal(detail: string): string | undefined {
  const match = /already holds (agent:[^;\s]+);/.exec(detail)
  return match?.[1]
}

/**
 * Scope choice with the exact 409 partition from the spec (component 4):
 * `registered` → prepare → attach; `participant_scope_occupied` /
 * `host_binding_conflict` → ADVANCE; `*_bound_elsewhere` /
 * `*_birth_designated_elsewhere` → redirect without advancing; `pending` →
 * hold for the next hook. A caller-supplied `scopeRef` (respawn) pins the
 * loop to one address with `expectedPredecessor`. A `resumeFromScope` seed
 * (from a write-ahead join.json, component 3(v)) is tried before the sequence.
 */
export async function chooseScopeAndJoin(input: ScopeJoinInput): Promise<ScopeJoinOutcome> {
  const adapter = input.adapter ?? createCodexDesktopParticipantAdapter()
  const slots: Iterator<string> =
    input.scopeRef !== undefined
      ? scopeRefsForPinned(input.scopeRef)
      : scopeRefsFor(input.projectId, input.maxSlots)
  const tried = new Set<string>()
  const queue: string[] =
    input.resumeFromScope !== undefined && input.scopeRef === undefined
      ? [input.resumeFromScope]
      : []
  const next = (): string | undefined => {
    for (;;) {
      const fromQueue = queue.shift()
      if (fromQueue !== undefined) {
        if (!tried.has(fromQueue)) return fromQueue
        continue
      }
      const fromSlots = slots.next()
      if (fromSlots.done === true) return undefined
      if (!tried.has(fromSlots.value)) return fromSlots.value
    }
  }
  const requestOptions = { timeoutMs: input.requestTimeoutMs }
  let examined = 0
  let scopeRef = next()
  while (scopeRef !== undefined) {
    tried.add(scopeRef)
    examined += 1
    input.onCandidateScope?.(scopeRef)
    const register = await registerParticipant(
      input.hrcSocketPath,
      {
        registrationMode: 'direct',
        requestedSessionRef: scopeRef,
        hostIncarnationId: input.hostIncarnationId,
        laneRef: DESKTOP_LANE_REF,
        classId: input.classId,
        participantKey: input.participantKey,
        workspaceCwd: input.workspaceCwd,
        socketPath: input.socketPath,
        ...(input.expectedPredecessor === undefined
          ? {}
          : { expectedPredecessor: input.expectedPredecessor }),
      },
      requestOptions
    )
    if (register.outcome !== 'registered') {
      if (register.outcome === 'pending') {
        return { exit: 'pending-hold', scopeRef, reason: register.reason, detail: register.detail }
      }
      // A slot this node permanently retired can never be ours again, so it
      // advances like an occupied one. Stopping there left the thread on its
      // provisional codex-<uuid> address, and mail to that address cold-birthed
      // a CLI seat (2026-09-26, arris:primary-quasar).
      if (
        isScopeOccupied(register) ||
        isHostBindingConflict(register) ||
        isScopeRetired(register)
      ) {
        if (input.scopeRef !== undefined) {
          return {
            exit: 'register-refused',
            scopeRef,
            reason: register.reason,
            detail: register.detail,
          }
        }
        scopeRef = next()
        continue
      }
      if (isIncarnationBoundElsewhere(register)) {
        const held = heldScopeFromIncarnationRefusal(register.detail)
        if (held !== undefined && !tried.has(held)) {
          queue.push(held)
          scopeRef = next()
          continue
        }
      }
      if (isRedirect(register)) {
        return {
          exit: 'redirect',
          scopeRef,
          reason: register.reason,
          ...(register.observed?.homeNodeId === undefined
            ? {}
            : { homeNodeId: register.observed.homeNodeId }),
        }
      }
      return {
        exit: 'register-refused',
        scopeRef,
        reason: register.reason,
        detail: register.detail,
      }
    }
    const prepared = await adapter.prepare({
      classId: input.classId,
      join: 'participant-served',
      participantKey: input.participantKey,
      workspaceCwd: input.workspaceCwd,
      preparation: input.preparation as never,
      identity: {
        requestId: register.identity.requestId as never,
        operationId: register.identity.operationId as never,
        hostSessionId: register.hostSessionId as never,
        generation: register.generation,
        runtimeId: register.identity.runtimeId as never,
        invocationId: register.identity.invocationId as never,
      },
      scopeRef: register.scopeRef,
      laneRef: register.identity.laneRef,
      attachEpoch: register.identity.attachEpoch,
    })
    if (prepared.status !== 'prepared') {
      return { exit: 'not-prepared', scopeRef, reason: prepared.reason }
    }
    const attach = await attachParticipant(
      input.hrcSocketPath,
      {
        registrationId: register.identity.registrationId,
        attemptId: register.identity.attemptId,
        attachEpoch: register.identity.attachEpoch,
        socketPath: input.socketPath,
        descriptor: prepared.descriptor,
      },
      requestOptions
    )
    if (attach.outcome !== 'attached') {
      if (attach.outcome === 'pending') {
        return { exit: 'pending-hold', scopeRef, reason: attach.reason, detail: attach.detail }
      }
      return { exit: 'attach-refused', scopeRef, reason: attach.reason, detail: attach.detail }
    }
    return {
      exit: 'joined',
      scopeRef: register.scopeRef,
      registrationId: register.identity.registrationId,
      attemptId: register.identity.attemptId,
      attachEpoch: register.identity.attachEpoch,
      runtimeId: register.identity.runtimeId,
      generation: register.generation,
      hostSessionId: register.hostSessionId,
    }
  }
  return { exit: 'scope-exhausted', detail: `examined ${examined} slots without a join` }
}

function* scopeRefsForPinned(scopeRef: string): Generator<string, void, void> {
  yield scopeRef
}

function* scopeRefsFor(projectId: string, maxSlots?: number): Generator<string, void, void> {
  let count = 0
  for (const slot of desktopSlotTokenSequence()) {
    yield desktopScopeRef(DESKTOP_AGENT_ID, projectId, slot)
    count += 1
    if (maxSlots !== undefined && count >= maxSlots) break
  }
}
