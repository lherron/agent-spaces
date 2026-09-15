import { describe, expect, test } from 'bun:test'
import {
  type WriterEvidence,
  type WriterLiveness,
  type WriterPathState,
  type WriterRef,
  validateParticipantAdapterAdmission,
  validateParticipantAdapterPreparation,
  validateWriterEvidence,
} from 'spaces-runtime-contracts'
import {
  type ControlledParticipantContinuityEvidence,
  createControlledParticipantAdapter as createControlledAdapter,
} from '../testing/controlled-participant-adapter.js'

const identity = {
  requestId: 'request:controlled-adapter' as never,
  operationId: 'runtimeOperation:controlled-adapter' as never,
  hostSessionId: 'hostSession:controlled-adapter' as never,
  generation: 1,
  runtimeId: 'runtime:controlled-adapter' as never,
  invocationId: 'invocation:controlled-adapter' as never,
}

describe('controlled participant adapter', () => {
  test('adapts both join directions using the committed HRC identity only', async () => {
    const adapter = createControlledAdapter({
      workspaceCwd: process.cwd(),
      dispatchEnv: { CONTROLLED_PARTICIPANT_ADAPTER: '1' },
    })
    for (const join of ['hrc-hosted', 'participant-served'] as const) {
      const admitted = await adapter.admit({ classId: 'controlled', join })
      expect(validateParticipantAdapterAdmission(admitted).ok).toBe(true)
      if (admitted.status !== 'admitted') throw new Error('controlled adapter did not admit')
      const prepared = await adapter.prepare({
        classId: 'controlled',
        join,
        participantKey: admitted.participantKey,
        workspaceCwd: admitted.workspaceCwd,
        preparation: admitted.preparation,
        identity,
        scopeRef: 'controlled@agent-spaces:test',
        laneRef: 'main',
        attachEpoch: 1,
      })
      const validation = validateParticipantAdapterPreparation(
        {
          classId: 'controlled',
          join,
          participantKey: admitted.participantKey,
          workspaceCwd: admitted.workspaceCwd,
          preparation: admitted.preparation,
          identity,
          scopeRef: 'controlled@agent-spaces:test',
          laneRef: 'main',
          attachEpoch: 1,
        },
        prepared
      )
      expect(validation.ok).toBe(true)
      if (prepared.status !== 'prepared') throw new Error('controlled adapter did not prepare')
      expect(prepared.profile.brokerOwnership).toBe(
        join === 'hrc-hosted' ? 'hrc-owned-process' : 'participant-owned-process'
      )
      expect('runtime' in prepared).toBe(false)
      expect('lifecyclePolicy' in prepared).toBe(false)
      expect(prepared.profile.harnessInvocation.startRequest.spec.correlation).toMatchObject({
        startRequestHash: prepared.profile.harnessInvocation.startRequestHash,
        selectedProfileHash: prepared.profile.profileHash,
      })
    }
  })

  test('replays only explicit opaque controlled continuity evidence', async () => {
    const adapter = createControlledAdapter({ workspaceCwd: process.cwd() })
    for (const token of ['first', 'same', 'changed', 'unknown'] as const) {
      const evidence = {
        kind: 'controlled-continuity/v1',
        token,
      } satisfies ControlledParticipantContinuityEvidence
      const admitted = await adapter.admit({
        classId: 'controlled',
        join: 'participant-served',
        evidence,
      })
      expect(admitted).toMatchObject({ status: 'admitted', continuityEvidence: evidence })
    }
    expect(
      await adapter.admit({ classId: 'controlled', join: 'participant-served' })
    ).not.toHaveProperty('continuityEvidence')
  })

  test('covers all nine retirement cells for host and bridge with both evidence methods', async () => {
    const cells: Array<{
      writePath: WriterPathState
      liveness: WriterLiveness
      branch: 'satisfied' | 'hold' | 'refuse'
    }> = [
      { writePath: 'retired', liveness: 'dead', branch: 'satisfied' },
      { writePath: 'retired', liveness: 'live', branch: 'satisfied' },
      { writePath: 'retired', liveness: 'unknown', branch: 'satisfied' },
      { writePath: 'unknown', liveness: 'dead', branch: 'satisfied' },
      { writePath: 'writable', liveness: 'dead', branch: 'satisfied' },
      { writePath: 'unknown', liveness: 'unknown', branch: 'hold' },
      { writePath: 'writable', liveness: 'unknown', branch: 'hold' },
      { writePath: 'unknown', liveness: 'live', branch: 'hold' },
      { writePath: 'writable', liveness: 'live', branch: 'refuse' },
    ]
    const recoveryStates = ['recovered', 'outstanding', 'unknown'] as const

    for (const subject of ['host', 'bridge'] as const) {
      for (const [index, cell] of cells.entries()) {
        const writerRef: WriterRef = {
          subject,
          classId: 'controlled',
          participantKey: `participant:${subject}`,
          attemptId: `attempt:${index}`,
          invocationId: `invocation:${subject}:${index}` as never,
          attachEpoch: index,
          ...(subject === 'host'
            ? { hostIncarnationId: `host-incarnation:${index}` }
            : { brokerInstanceId: `broker:${index}` }),
        }
        const priorRecovery = recoveryStates[index % recoveryStates.length]
        const adapter = createControlledAdapter({
          workspaceCwd: process.cwd(),
          writerEvidence: {
            observedAt: '2026-09-15T15:00:00.000Z',
            writePath: { state: cell.writePath },
            liveness: { state: cell.liveness },
            priorRecovery: { state: priorRecovery },
          },
        })
        if (adapter.retireWriter === undefined || adapter.inspectWriter === undefined) {
          throw new Error('controlled adapter must expose both writer evidence methods')
        }
        for (const [method, request] of [
          [adapter.retireWriter, { writerRef, reason: 'controlled successor' }],
          [adapter.inspectWriter, { writerRef }],
        ] as const) {
          const evidence = await method(request as never)
          expect(validateWriterEvidence(request, evidence).ok).toBe(true)
          expect(evidence.priorRecovery.state).toBe(priorRecovery)
          const branch =
            evidence.writePath.state === 'retired' || evidence.liveness.state === 'dead'
              ? 'satisfied'
              : evidence.writePath.state === 'writable' && evidence.liveness.state === 'live'
                ? 'refuse'
                : 'hold'
          expect(branch).toBe(cell.branch)
        }
      }
    }
  })

  test('validator rejects controlled evidence replayed for a different subject or identity', async () => {
    const adapter = createControlledAdapter({
      workspaceCwd: process.cwd(),
      writerEvidence: {
        writePath: { state: 'retired' },
        liveness: { state: 'live' },
        priorRecovery: { state: 'recovered' },
      },
    })
    if (adapter.inspectWriter === undefined) throw new Error('inspectWriter missing')
    const bridgeRef: WriterRef = {
      subject: 'bridge',
      classId: 'controlled',
      participantKey: 'participant:controlled',
      attemptId: 'attempt:1',
      invocationId: 'invocation:1' as never,
      attachEpoch: 1,
      brokerInstanceId: 'broker:1',
    }
    const evidence = (await adapter.inspectWriter({ writerRef: bridgeRef })) as WriterEvidence
    const hostRef: WriterRef = {
      ...bridgeRef,
      subject: 'host',
      hostIncarnationId: 'host-incarnation:1',
      brokerInstanceId: undefined,
    }
    expect(validateWriterEvidence({ writerRef: hostRef }, evidence)).toMatchObject({ ok: false })
    expect(
      validateWriterEvidence({ writerRef: { ...bridgeRef, attachEpoch: 2 } }, evidence)
    ).toMatchObject({ ok: false })
  })
})
