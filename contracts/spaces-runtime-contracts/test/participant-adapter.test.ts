import { describe, expect, test } from 'bun:test'
import type {
  BrokerExecutionProfile,
  ParticipantAdapter,
  ParticipantAdapterAdmissionRequest,
  ParticipantAdapterAdmissionResult,
  ParticipantAdapterJoin,
  ParticipantAdapterPreparationRequest,
  ParticipantAdapterPreparationResult,
  ParticipantAdapterValidationIssue,
  ParticipantAdapterValidationResult,
} from '../src/index'
import {
  neutralBrokerExecutionProfileHash,
  neutralSpecHash,
  neutralStartRequestHash,
  validateParticipantAdapterAdmission,
  validateParticipantAdapterPreparation,
} from '../src/index'

function request(): ParticipantAdapterPreparationRequest {
  return {
    classId: 'controlled',
    join: 'participant-served',
    participantKey: 'participant:controlled',
    workspaceCwd: '/tmp/participant-adapter',
    preparation: { opaque: true },
    identity: {
      requestId: 'request:participant' as never,
      operationId: 'runtimeOperation:participant' as never,
      hostSessionId: 'hostSession:participant' as never,
      generation: 3,
      runtimeId: 'runtime:participant' as never,
      invocationId: 'invocation:participant' as never,
    },
    scopeRef: 'participant@agent-spaces:controlled',
    laneRef: 'main',
    attachEpoch: 1,
  }
}

function profile(input: ParticipantAdapterPreparationRequest): BrokerExecutionProfile {
  const startRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1' as const,
      invocationId: input.identity.invocationId,
      harness: { frontend: 'test', provider: 'test', driver: 'controlled-driver' },
      process: {
        command: 'controlled-driver',
        args: [],
        cwd: input.workspaceCwd,
        lockedEnv: {},
        harnessTransport: { kind: 'pipes' as const },
      },
      interaction: {
        mode: 'headless' as const,
        turnConcurrency: 'single' as const,
        inputQueue: 'none' as const,
      },
      driver: { kind: 'controlled-driver' },
      correlation: {
        runtimeId: String(input.identity.runtimeId),
        hostSessionId: String(input.identity.hostSessionId),
        generation: String(input.identity.generation),
        invocationId: String(input.identity.invocationId),
      },
    },
  }
  const value = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile:participant' as never,
    profileHash: '',
    compatibilityHash: 'compatibility:participant',
    kind: 'harness-broker' as const,
    interactionMode: 'headless' as const,
    expectedCapabilities: {},
    brokerProtocol: 'harness-broker/0.2' as const,
    brokerDriver: 'controlled-driver',
    brokerOwnership: 'participant-owned-process' as const,
    harnessInvocation: {
      startRequest,
      specHash: neutralSpecHash(startRequest.spec),
      startRequestHash: neutralStartRequestHash(startRequest),
    },
    policy: {
      permissionPolicy: { mode: 'deny' as const, audit: true },
      inputPolicy: {
        readyInput: 'start-turn' as const,
        busy: { whenBusy: 'reject' as const },
        supportedKinds: ['user'],
        attachmentPolicy: { localImages: false, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' as const },
    },
    observability: {
      correlation: {
        requestId: input.identity.requestId,
        operationId: input.identity.operationId,
        hostSessionId: input.identity.hostSessionId,
        generation: input.identity.generation,
        runtimeId: input.identity.runtimeId,
        invocationId: input.identity.invocationId,
      },
    },
  } as BrokerExecutionProfile
  return { ...value, profileHash: neutralBrokerExecutionProfileHash(value) }
}

describe('participant adapter contract', () => {
  test('names the complete public type surface', () => {
    const admissionRequest: ParticipantAdapterAdmissionRequest = {
      classId: 'controlled',
      join: 'hrc-hosted',
    }
    const admissionResult: ParticipantAdapterAdmissionResult = {
      status: 'pending',
      reason: 'waiting',
    }
    const preparationResult: ParticipantAdapterPreparationResult = {
      status: 'rejected',
      reason: 'refused',
    }
    const adapter: ParticipantAdapter = {
      adapterId: 'contract-surface',
      admit: () => admissionResult,
      prepare: () => preparationResult,
    }
    const issue: ParticipantAdapterValidationIssue = { path: 'status', message: 'example' }
    const validation: ParticipantAdapterValidationResult<ParticipantAdapterAdmissionResult> = {
      ok: true,
      value: admissionResult,
    }
    const join: ParticipantAdapterJoin = admissionRequest.join

    expect([adapter.adapterId, issue.path, validation.ok, join]).toEqual([
      'contract-surface',
      'status',
      true,
      'hrc-hosted',
    ])
  })

  test('accepts opaque JSON admission and refuses non-JSON evidence', () => {
    expect(
      validateParticipantAdapterAdmission({
        status: 'admitted',
        participantKey: 'participant:controlled',
        workspaceCwd: '/tmp/participant-adapter',
        preparation: { nested: [true, null, 1] },
        continuityEvidence: { generation: 1 },
      }).ok
    ).toBe(true)

    expect(
      validateParticipantAdapterAdmission({
        status: 'admitted',
        participantKey: 'participant:controlled',
        workspaceCwd: '/tmp/participant-adapter',
        preparation: { invalid: BigInt(1) },
      })
    ).toMatchObject({ ok: false })
  })

  test('validates identity, ownership, and neutral hashes without a harness-name selector', () => {
    const input = request()
    const result = validateParticipantAdapterPreparation(input, {
      status: 'prepared',
      profile: profile(input),
      dispatchEnv: { CONTROLLED_PARTICIPANT: '1' },
    })
    expect(result.ok).toBe(true)
  })

  test('refuses HRC-owned overlays and profile/hash drift', () => {
    const input = request()
    const prepared = profile(input)
    const rejected = validateParticipantAdapterPreparation(input, {
      status: 'prepared',
      profile: { ...prepared, profileHash: 'tampered' },
      runtime: { terminalSurface: {} },
      lifecyclePolicy: { policyId: 'adapter-must-not-own-this' },
    })
    expect(rejected).toMatchObject({ ok: false })
    if (rejected.ok) return
    expect(rejected.issues.map((issue) => issue.path)).toContain('profile.profileHash')
    expect(rejected.issues.map((issue) => issue.message).join(' ')).toMatch(
      /runtime.*lifecyclePolicy/i
    )
  })

  test('refuses ownership that does not truthfully match join direction', () => {
    const input = request()
    const rejected = validateParticipantAdapterPreparation(input, {
      status: 'prepared',
      profile: { ...profile(input), brokerOwnership: 'hrc-owned-process' },
    })
    expect(rejected).toMatchObject({ ok: false })
    if (rejected.ok) return
    expect(rejected.issues.map((issue) => issue.path)).toContain('profile.brokerOwnership')
  })
})
