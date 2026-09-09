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

export type ControlledParticipantAdapterOptions = {
  /** Required because admission has no workspace field to infer from. */
  workspaceCwd: string
  adapterId?: string | undefined
  dispatchEnv?: Record<string, string> | undefined
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

function buildProfile(
  adapterId: string,
  request: ParticipantAdapterPreparationRequest
): BrokerExecutionProfile {
  const startRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1' as const,
      invocationId: request.identity.invocationId,
      labels: { adapter: adapterId, participantClass: request.classId },
      harness: {
        frontend: 'codex',
        provider: 'openai',
        driver: 'codex-app-server',
      },
      process: {
        command: 'codex',
        args: ['app-server'],
        cwd: request.workspaceCwd,
        lockedEnv: {},
        harnessTransport: { kind: 'jsonrpc-stdio' as const },
      },
      interaction: {
        mode: 'headless' as const,
        turnConcurrency: 'single' as const,
        inputQueue: 'fifo' as const,
      },
      driver: { kind: 'codex-app-server' as const },
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
    brokerDriver: 'codex-app-server',
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
  return { ...profile, profileHash: neutralBrokerExecutionProfileHash(profile) }
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
  return {
    adapterId,
    admit(input) {
      return {
        status: 'admitted',
        participantKey: input.participantKey ?? `controlled:${input.classId}`,
        workspaceCwd: options.workspaceCwd,
        preparation: controlledPreparation(input),
        continuityEvidence: { adapterId, classId: input.classId },
      }
    },
    prepare(input) {
      const profile = buildProfile(adapterId, input)
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
