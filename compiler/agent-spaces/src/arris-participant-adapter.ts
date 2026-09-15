import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  type ArrisHostDescriptor,
  type ArrisHostLifecycleOwner,
  validateArrisHostDescriptor,
} from 'spaces-harness-broker-protocol'
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

export const ARRIS_PARTICIPANT_ADAPTER_ID = 'arris-resident-participant-adapter/v1'
export const ARRIS_RESIDENT_DRIVER_KIND = 'arris-resident'

export type ArrisParticipantEvidence = {
  schema: 'arris.participant-evidence/1'
  descriptorPath: string
}

export type ArrisParticipantPreparation = {
  schema: 'arris.participant-preparation/1'
  descriptorPath: string
  hostIncarnationId: string
  hostPid: number
  lifecycleOwner: ArrisHostLifecycleOwner
  launchId: string | null
}

export type ArrisParticipantContinuityEvidence = {
  schema: 'arris.host-continuity/1'
  host_incarnation_id: string
  process: ArrisHostDescriptor['host_incarnation']['process']
  resident_binding: {
    thread_id: string
    rebind_count: number
  }
}

export type ArrisParticipantAdapterOptions = {
  workspaceCwd: string
  /** Stable logical participant key. It must not be derived from a host process lifetime. */
  participantKey?: string | undefined
  adapterId?: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEvidence(value: unknown): ArrisParticipantEvidence | undefined {
  if (!isRecord(value)) return undefined
  if (
    value['schema'] !== 'arris.participant-evidence/1' ||
    typeof value['descriptorPath'] !== 'string' ||
    !isAbsolute(value['descriptorPath']) ||
    Object.keys(value).some((key) => key !== 'schema' && key !== 'descriptorPath')
  ) {
    return undefined
  }
  return value as ArrisParticipantEvidence
}

async function readDescriptor(path: string): Promise<ArrisHostDescriptor | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
  const validation = validateArrisHostDescriptor(value)
  return validation.ok ? validation.value : undefined
}

function preparationFrom(
  descriptorPath: string,
  descriptor: ArrisHostDescriptor
): ArrisParticipantPreparation {
  return {
    schema: 'arris.participant-preparation/1',
    descriptorPath,
    hostIncarnationId: descriptor.host_incarnation.host_incarnation_id,
    hostPid: descriptor.host_incarnation.process.pid,
    lifecycleOwner: descriptor.lifecycle.host_lifecycle_owner,
    launchId: descriptor.lifecycle.launch_id,
  }
}

function parsePreparation(value: unknown): ArrisParticipantPreparation | undefined {
  if (!isRecord(value)) return undefined
  const keys = [
    'schema',
    'descriptorPath',
    'hostIncarnationId',
    'hostPid',
    'lifecycleOwner',
    'launchId',
  ]
  if (Object.keys(value).some((key) => !keys.includes(key))) return undefined
  if (
    value['schema'] !== 'arris.participant-preparation/1' ||
    typeof value['descriptorPath'] !== 'string' ||
    !isAbsolute(value['descriptorPath']) ||
    typeof value['hostIncarnationId'] !== 'string' ||
    !Number.isInteger(value['hostPid']) ||
    (value['hostPid'] as number) < 1 ||
    (value['lifecycleOwner'] !== 'external' && value['lifecycleOwner'] !== 'hrc-managed') ||
    (value['launchId'] !== null && typeof value['launchId'] !== 'string')
  ) {
    return undefined
  }
  return value as ArrisParticipantPreparation
}

function continuityFrom(descriptor: ArrisHostDescriptor): ArrisParticipantContinuityEvidence {
  return {
    schema: 'arris.host-continuity/1',
    host_incarnation_id: descriptor.host_incarnation.host_incarnation_id,
    process: descriptor.host_incarnation.process,
    resident_binding: {
      thread_id: descriptor.resident_binding.thread_id,
      rebind_count: descriptor.resident_binding.rebind_count,
    },
  }
}

function stableId(prefix: 'profile' | 'compatibility', value: unknown): string {
  const hash = createCanonicalHasher().hash(value, {
    timestampMode: 'omit-ephemeral',
  }).value
  return `${prefix}_${hash.slice(0, 32)}`
}

function buildProfile(
  adapterId: string,
  request: ParticipantAdapterPreparationRequest,
  preparation: ArrisParticipantPreparation
): BrokerExecutionProfile {
  const startRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1' as const,
      invocationId: request.identity.invocationId,
      labels: {
        adapter: adapterId,
        participantClass: request.classId,
        arrisHostIncarnation: preparation.hostIncarnationId,
      },
      harness: {
        frontend: 'arris',
        provider: 'openai',
        driver: ARRIS_RESIDENT_DRIVER_KIND,
      },
      process: {
        command: 'arris-resident-external',
        args: [],
        cwd: request.workspaceCwd,
        lockedEnv: {},
        harnessTransport: { kind: 'in-process' as const },
      },
      interaction: {
        mode: 'headless' as const,
        turnConcurrency: 'single' as const,
        inputQueue: 'fifo' as const,
      },
      driver: {
        kind: ARRIS_RESIDENT_DRIVER_KIND,
        descriptorPath: preparation.descriptorPath,
        hostIncarnationId: preparation.hostIncarnationId,
        hostLifecycleOwner: preparation.lifecycleOwner,
        launchId: preparation.launchId,
      },
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
    startRequest,
  })
  const compatibilityHash = stableId('compatibility', {
    adapterId,
    join: request.join,
    classId: request.classId,
    lifecycleOwner: preparation.lifecycleOwner,
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
        steer: 'required',
        appendContext: 'forbidden',
        localImages: 'forbidden',
        fileRefs: 'forbidden',
        queue: 'required',
      },
      turns: { concurrency: 'single', interrupt: 'forbidden' },
      continuation: 'required',
      permissions: 'none',
      events: {
        assistantDeltas: 'required',
        toolCalls: 'required',
        usage: 'optional',
        diagnostics: 'required',
      },
      control: {
        stop: preparation.lifecycleOwner === 'hrc-managed' ? 'optional' : 'forbidden',
        dispose: 'required',
        reconcile: 'required',
        attachReplay: 'required',
      },
      lifecycle: {
        runtimeRetention: ['unmanaged', 'keep-alive'],
        harnessRecovery: ['none', 'fail-and-escalate'],
        turnRetry: ['none', 'safe-retry'],
        generationFencing: 'required',
        permissionCancellation: 'optional',
      },
    },
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: ARRIS_RESIDENT_DRIVER_KIND,
    brokerOwnership:
      request.join === 'participant-served' ? 'participant-owned-process' : 'hrc-owned-process',
    harnessInvocation: {
      startRequest,
      specHash: neutralSpecHash(startRequest.spec),
      startRequestHash: neutralStartRequestHash(startRequest),
    },
    continuation: {
      broker: {
        provider: 'arris',
        continuationId: preparation.hostIncarnationId,
        key: preparation.hostIncarnationId,
        kind: 'host-incarnation',
      },
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

function admissionPending(reason: string) {
  return { status: 'pending' as const, reason }
}

/** Static production adapter for one externally served Arris resident host. */
export function createArrisParticipantAdapter(
  options: ArrisParticipantAdapterOptions
): ParticipantAdapter {
  const adapterId = options.adapterId ?? ARRIS_PARTICIPANT_ADAPTER_ID
  return {
    adapterId,
    async admit(request: ParticipantAdapterAdmissionRequest) {
      const evidence = parseEvidence(request.evidence)
      if (evidence === undefined) return admissionPending('arris_host_evidence_invalid')
      const participantKey = request.participantKey ?? options.participantKey
      if (participantKey === undefined || participantKey.length === 0) {
        return admissionPending('arris_participant_key_required')
      }
      const descriptor = await readDescriptor(evidence.descriptorPath)
      if (descriptor === undefined) return admissionPending('arris_host_descriptor_invalid')
      if (descriptor.control.socket_path === null) {
        return admissionPending('arris_host_control_starting')
      }
      if (!descriptor.readiness.accepts_input) return admissionPending('arris_host_not_ready')
      return {
        status: 'admitted',
        participantKey,
        workspaceCwd: options.workspaceCwd,
        preparation: preparationFrom(evidence.descriptorPath, descriptor),
        continuityEvidence: continuityFrom(descriptor),
      }
    },
    async prepare(request: ParticipantAdapterPreparationRequest) {
      const preparation = parsePreparation(request.preparation)
      if (preparation === undefined) return admissionPending('arris_preparation_invalid')
      const descriptor = await readDescriptor(preparation.descriptorPath)
      if (descriptor === undefined) return admissionPending('arris_host_descriptor_invalid')
      if (descriptor.host_incarnation.host_incarnation_id !== preparation.hostIncarnationId) {
        return { status: 'rejected', reason: 'arris_host_incarnation_changed' }
      }
      if (descriptor.control.socket_path === null) {
        return admissionPending('arris_host_control_starting')
      }
      if (!descriptor.readiness.accepts_input) return admissionPending('arris_host_not_ready')
      return {
        status: 'prepared',
        profile: buildProfile(adapterId, request, preparation),
      }
    },
  }
}
