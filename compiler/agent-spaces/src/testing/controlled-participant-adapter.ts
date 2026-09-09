import {
  type BrokerExecutionProfile,
  type ParticipantAdapter,
  type ParticipantAdapterAdmissionRequest,
  type ParticipantAdapterPreparationRequest,
  createCanonicalHasher,
  neutralBrokerExecutionProfileHash,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

/**
 * Explicit fixture-only continuity evidence accepted by the controlled adapter.
 *
 * The token is deliberately opaque to product code: a consumer persists and
 * replays this exact JSON value so a test can distinguish first, same, changed,
 * and unknown evidence. It is not a claim about a native harness signal.
 */
export type ControlledParticipantContinuityEvidence = {
  kind: 'controlled-continuity/v1'
  token: 'first' | 'same' | 'changed' | 'unknown'
}

/** The controlled helper's explicit driver choice; production callers get Codex. */
export type ControlledParticipantAdapterDriver = 'codex-app-server' | 'noop-driver'

export type ControlledParticipantAdapterOptions = {
  /** Required because admission has no workspace field to infer from. */
  workspaceCwd: string
  adapterId?: string | undefined
  dispatchEnv?: Record<string, string> | undefined
  /** Test-only hermetic driver selection; defaults to the published Codex profile. */
  driver?: ControlledParticipantAdapterDriver | undefined
}

function stableId(prefix: 'profile' | 'compatibility', value: unknown): string {
  return `${prefix}_${createCanonicalHasher().hash(value, { timestampMode: 'omit-ephemeral' }).value.slice(0, 32)}`
}

function controlledPreparation(input: ParticipantAdapterAdmissionRequest): Record<string, string> {
  return {
    adapterId: 'controlled-participant-adapter/v1',
    classId: input.classId,
    join: input.join,
  }
}

function controlledContinuityEvidence(
  evidence: ParticipantAdapterAdmissionRequest['evidence']
): ControlledParticipantContinuityEvidence | undefined {
  if (evidence === undefined) return undefined
  if (
    typeof evidence === 'object' &&
    evidence !== null &&
    !Array.isArray(evidence) &&
    evidence['kind'] === 'controlled-continuity/v1' &&
    (evidence['token'] === 'first' ||
      evidence['token'] === 'same' ||
      evidence['token'] === 'changed' ||
      evidence['token'] === 'unknown') &&
    Object.keys(evidence).length === 2
  ) {
    return evidence as ControlledParticipantContinuityEvidence
  }
  return undefined
}

function buildProfile(
  adapterId: string,
  request: ParticipantAdapterPreparationRequest,
  driver: ControlledParticipantAdapterDriver
): BrokerExecutionProfile {
  const isNoop = driver === 'noop-driver'
  const startRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1' as const,
      invocationId: request.identity.invocationId,
      labels: { adapter: adapterId, participantClass: request.classId },
      harness: {
        frontend: isNoop ? 'test' : 'codex',
        provider: isNoop ? 'test' : 'openai',
        driver,
      },
      process: {
        command: isNoop ? 'noop-driver' : 'codex',
        args: isNoop ? [] : ['app-server'],
        cwd: request.workspaceCwd,
        lockedEnv: {},
        harnessTransport: { kind: isNoop ? ('pipes' as const) : ('jsonrpc-stdio' as const) },
      },
      interaction: {
        mode: 'headless' as const,
        turnConcurrency: 'single' as const,
        inputQueue: isNoop ? ('none' as const) : ('fifo' as const),
      },
      driver: { kind: driver },
      correlation: {
        runtimeId: String(request.identity.runtimeId),
        hostSessionId: String(request.identity.hostSessionId),
        generation: String(request.identity.generation),
        invocationId: String(request.identity.invocationId),
      },
    },
  }
  const profileId = stableId('profile', {
    adapterId,
    join: request.join,
    startRequest: startRequest.spec,
  })
  const compatibilityHash = stableId('compatibility', {
    adapterId,
    join: request.join,
    classId: request.classId,
  })
  const profile: BrokerExecutionProfile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: profileId as BrokerExecutionProfile['profileId'],
    profileHash: '',
    compatibilityHash,
    kind: 'harness-broker',
    interactionMode: 'headless',
    expectedCapabilities: {
      input: {
        user: 'required',
        steer: 'optional',
        appendContext: 'optional',
        localImages: 'optional',
        fileRefs: 'forbidden',
        queue: 'required',
      },
      turns: { concurrency: 'single', interrupt: 'optional' },
      continuation: 'optional',
      permissions: 'none',
      events: {
        assistantDeltas: 'optional',
        toolCalls: 'required',
        usage: 'optional',
        diagnostics: 'optional',
      },
      control: {
        stop: 'optional',
        dispose: 'optional',
        reconcile: 'optional',
        attachReplay: 'optional',
      },
      lifecycle: {
        runtimeRetention: ['keep-alive', 'idle-ttl'],
        harnessRecovery: ['none', 'fail-and-escalate'],
        turnRetry: ['none'],
        generationFencing: 'required',
        permissionCancellation: 'optional',
      },
    },
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: driver,
    brokerOwnership:
      request.join === 'participant-served' ? 'participant-owned-process' : 'hrc-owned-process',
    harnessInvocation: {
      startRequest,
      specHash: neutralSpecHash(startRequest.spec),
      startRequestHash: neutralStartRequestHash(startRequest),
    },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {
        readyInput: 'start-turn',
        busy: { whenBusy: 'queue', maxDepth: 1 },
        supportedKinds: ['user'],
        attachmentPolicy: { localImages: false, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' },
    },
    observability: {
      correlation: {
        requestId: request.identity.requestId,
        operationId: request.identity.operationId,
        hostSessionId: request.identity.hostSessionId,
        generation: request.identity.generation,
        runtimeId: request.identity.runtimeId,
        invocationId: request.identity.invocationId,
        ...(request.identity.runId !== undefined ? { runId: request.identity.runId } : {}),
        ...(request.identity.traceId !== undefined ? { traceId: request.identity.traceId } : {}),
      },
    },
  }
  const profileHash = neutralBrokerExecutionProfileHash(profile)
  const startRequestHash = profile.harnessInvocation.startRequestHash
  return {
    ...profile,
    profileHash,
    harnessInvocation: {
      ...profile.harnessInvocation,
      startRequest: {
        ...startRequest,
        spec: {
          ...startRequest.spec,
          correlation: {
            ...startRequest.spec.correlation,
            startRequestHash,
            selectedProfileHash: profileHash,
          },
        },
      },
    },
  }
}

/**
 * Controlled E2E/test adapter shipped through `agent-spaces/testing`.
 * It builds a real codex-app-server broker invocation from HRC's committed
 * allocation and never creates a runtime handle or lifecycle overlay.
 */
export function createControlledParticipantAdapter(
  options: ControlledParticipantAdapterOptions
): ParticipantAdapter {
  const adapterId = options.adapterId ?? 'controlled-participant-adapter/v1'
  const driver = options.driver ?? 'codex-app-server'
  return {
    adapterId,
    admit(input) {
      return {
        status: 'admitted',
        participantKey: input.participantKey ?? `controlled:${input.classId}`,
        workspaceCwd: options.workspaceCwd,
        preparation: controlledPreparation(input),
        ...(controlledContinuityEvidence(input.evidence) === undefined
          ? {}
          : { continuityEvidence: controlledContinuityEvidence(input.evidence) }),
      }
    },
    prepare(input) {
      const profile = buildProfile(adapterId, input, driver)
      if (options.dispatchEnv === undefined) {
        return {
          status: 'prepared',
          profile,
        }
      }
      return {
        status: 'prepared',
        profile,
        dispatchEnv: options.dispatchEnv,
      }
    },
  }
}
