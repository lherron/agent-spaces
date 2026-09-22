import { describe, expect, test } from 'bun:test'
import type {
  ParticipantAdapter,
  ParticipantAdapterAdmissionRequest,
  ParticipantAdapterAdmissionResult,
  ParticipantAdapterJoin,
  ParticipantAdapterPreparationRequest,
  ParticipantAdapterPreparationResult,
  ParticipantAdapterValidationIssue,
  ParticipantAdapterValidationResult,
  ParticipantBrokerDescriptor,
  PriorRecovery,
  WriterEvidence,
  WriterInspectionRequest,
  WriterLiveness,
  WriterPathState,
  WriterRef,
  WriterRetirementRequest,
  WriterSubject,
} from '../src/index'
import {
  neutralParticipantBrokerDescriptorHash,
  neutralSpecHash,
  neutralStartRequestHash,
  validateParticipantAdapterAdmission,
  validateParticipantAdapterPreparation,
  validateParticipantBrokerDescriptor,
  validateWriterEvidence,
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

function descriptor(input: ParticipantAdapterPreparationRequest): ParticipantBrokerDescriptor {
  const startRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1' as const,
      invocationId: input.identity.invocationId,
      harness: {
        frontend: 'test',
        provider: 'test',
        driver: 'controlled-driver',
      },
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
    schemaVersion: 'participant-broker-descriptor/v1',
    descriptorId: 'participantBrokerDescriptor:participant' as never,
    descriptorHash: '',
    compatibilityHash: 'compatibility:participant',
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
  } as ParticipantBrokerDescriptor
  const descriptorHash = neutralParticipantBrokerDescriptorHash(value)
  return {
    ...value,
    descriptorHash,
    harnessInvocation: {
      ...value.harnessInvocation,
      startRequest: {
        ...startRequest,
        spec: {
          ...startRequest.spec,
          correlation: {
            ...startRequest.spec.correlation,
            startRequestHash: value.harnessInvocation.startRequestHash,
            selectedProfileHash: descriptorHash,
          },
        },
      },
    },
  }
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
    const issue: ParticipantAdapterValidationIssue = {
      path: 'status',
      message: 'example',
    }
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

  test('exports the writer evidence surface without requiring it on legacy adapters', () => {
    const subject: WriterSubject = 'bridge'
    const writePath: WriterPathState = 'retired'
    const liveness: WriterLiveness = 'live'
    const priorRecovery: PriorRecovery = 'unknown'
    const writerRef: WriterRef = {
      subject,
      classId: 'controlled',
      participantKey: 'participant:controlled',
      attemptId: 'attempt:1',
      invocationId: 'invocation:1' as never,
      attachEpoch: 2,
      brokerInstanceId: 'broker:1',
    }
    const retirement: WriterRetirementRequest = {
      writerRef,
      reason: 'successor requested',
    }
    const inspection: WriterInspectionRequest = { writerRef }
    const evidence: WriterEvidence = {
      schemaVersion: 'writer-evidence/v1',
      writerRef,
      observedAt: '2026-09-15T15:00:00.000Z',
      writePath: { state: writePath, reason: 'closed' },
      liveness: { state: liveness, reason: 'still serving reads' },
      priorRecovery: { state: priorRecovery, reason: 'not inspected' },
    }
    expect(validateWriterEvidence(retirement, evidence)).toEqual({
      ok: true,
      value: evidence,
    })
    expect(validateWriterEvidence(inspection, evidence)).toEqual({
      ok: true,
      value: evidence,
    })
  })

  test('rejects malformed writer axes and a response for a different identity', () => {
    const writerRef: WriterRef = {
      subject: 'host',
      classId: 'controlled',
      participantKey: 'participant:controlled',
      attemptId: 'attempt:1',
      invocationId: 'invocation:1' as never,
      attachEpoch: 2,
      hostIncarnationId: 'host-incarnation:1',
    }
    const rejected = validateWriterEvidence(
      { writerRef },
      {
        schemaVersion: 'writer-evidence/v1',
        writerRef: { ...writerRef, attemptId: 'attempt:other' },
        observedAt: 'not-a-timestamp',
        writePath: { state: 'closed', reason: '' },
        liveness: { state: 'live', reason: 'observed', detail: BigInt(1) },
        priorRecovery: { state: 'reconciled', reason: 'wrong vocabulary' },
      }
    )
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'writerRef',
        'observedAt',
        'writePath.state',
        'writePath.reason',
        'liveness.detail',
        'priorRecovery.state',
      ])
    )
  })

  test('requires explicit bridge identity and preserves unknown as a valid axis state', () => {
    const writerRef = {
      subject: 'bridge',
      classId: 'controlled',
      participantKey: 'participant:controlled',
      attemptId: 'attempt:1',
      invocationId: 'invocation:1',
      attachEpoch: 0,
    } as unknown as WriterRef
    const result = validateWriterEvidence(
      { writerRef },
      {
        schemaVersion: 'writer-evidence/v1',
        writerRef,
        observedAt: '2026-09-15T10:00:00-05:00',
        writePath: { state: 'unknown', reason: 'not observed' },
        liveness: { state: 'unknown', reason: 'not observed' },
        priorRecovery: { state: 'unknown', reason: 'not observed' },
      }
    )
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.issues.map((issue) => issue.path)).toContain('writerRef.brokerInstanceId')
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
      descriptor: descriptor(input),
      dispatchEnv: { CONTROLLED_PARTICIPANT: '1' },
    })
    expect(result.ok).toBe(true)
  })

  test('keeps compatibilityHash outside neutral descriptor hash material', () => {
    const prepared = descriptor(request())
    expect(
      neutralParticipantBrokerDescriptorHash({
        ...prepared,
        compatibilityHash: 'compatibility:changed',
      })
    ).toBe(neutralParticipantBrokerDescriptorHash(prepared))
  })

  test('refuses HRC-owned overlays and descriptor/hash drift', () => {
    const input = request()
    const prepared = descriptor(input)
    const rejected = validateParticipantAdapterPreparation(input, {
      status: 'prepared',
      descriptor: { ...prepared, descriptorHash: 'tampered' },
      runtime: { terminalSurface: {} },
      lifecyclePolicy: { policyId: 'adapter-must-not-own-this' },
    })
    expect(rejected).toMatchObject({ ok: false })
    if (rejected.ok) return
    expect(rejected.issues.map((issue) => issue.path)).toContain('descriptor.descriptorHash')
    expect(rejected.issues.map((issue) => issue.message).join(' ')).toMatch(
      /runtime.*lifecyclePolicy/i
    )
  })

  test('refuses ownership that does not truthfully match join direction', () => {
    const input = request()
    const rejected = validateParticipantAdapterPreparation(input, {
      status: 'prepared',
      descriptor: { ...descriptor(input), brokerOwnership: 'hrc-owned-process' },
    })
    expect(rejected).toMatchObject({ ok: false })
    if (rejected.ok) return
    expect(rejected.issues.map((issue) => issue.path)).toContain('descriptor.brokerOwnership')
  })

  test('refuses prepared output whose correlation cannot satisfy installed identity', () => {
    const input = request()
    const prepared = descriptor(input)
    const rejected = validateParticipantAdapterPreparation(input, {
      status: 'prepared',
      descriptor: {
        ...prepared,
        harnessInvocation: {
          ...prepared.harnessInvocation,
          startRequest: {
            ...prepared.harnessInvocation.startRequest,
            spec: {
              ...prepared.harnessInvocation.startRequest.spec,
              correlation: {
                ...prepared.harnessInvocation.startRequest.spec.correlation,
                startRequestHash: 'wrong-start-request-hash',
              },
            },
          },
        },
      },
    })
    expect(rejected).toMatchObject({ ok: false })
    if (rejected.ok) return
    expect(rejected.issues.map((issue) => issue.path)).toContain(
      'descriptor.harnessInvocation.startRequest.spec.correlation.startRequestHash'
    )
  })

  test('accepts the participant descriptor schema and refuses the retired profile schema first', () => {
    const input = request()
    const accepted = descriptor(input)
    expect(validateParticipantBrokerDescriptor(accepted)).toMatchObject({ ok: true })

    const rejected = validateParticipantAdapterPreparation(input, {
      status: 'prepared',
      descriptor: {
        ...accepted,
        schemaVersion: 'agent-runtime-profile/v1',
      },
    })
    expect(rejected).toMatchObject({ ok: false })
    if (rejected.ok) return
    expect(rejected.issues.map((issue) => issue.path)).toContain('descriptor.schemaVersion')

    const invalidStartRequest = validateParticipantBrokerDescriptor({
      ...accepted,
      harnessInvocation: {
        ...accepted.harnessInvocation,
        startRequest: {
          ...accepted.harnessInvocation.startRequest,
          spec: {
            ...accepted.harnessInvocation.startRequest.spec,
            specVersion: 'retired-invocation-schema',
          },
        },
      },
    })
    expect(invalidStartRequest).toMatchObject({ ok: false })
    if (invalidStartRequest.ok) return
    expect(invalidStartRequest.issues.map((issue) => issue.path)).toContain(
      'harnessInvocation.startRequest'
    )
  })
})
