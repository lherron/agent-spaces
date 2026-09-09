import { describe, expect, test } from 'bun:test'
import {
  validateParticipantAdapterAdmission,
  validateParticipantAdapterPreparation,
} from 'spaces-runtime-contracts'
import { createControlledParticipantAdapter as createControlledAdapter } from '../testing/controlled-participant-adapter.js'

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
    }
  })
})
