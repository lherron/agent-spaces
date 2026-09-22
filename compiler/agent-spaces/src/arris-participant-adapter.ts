import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  type ArrisHostDescriptor,
  type ArrisHostLifecycleOwner,
  validateArrisHostDescriptor,
} from 'spaces-harness-broker-protocol'
import {
  type ParticipantAdapter,
  type ParticipantAdapterAdmissionRequest,
  type ParticipantAdapterPreparationRequest,
  type ParticipantBrokerDescriptor,
  createCanonicalHasher,
  neutralParticipantBrokerDescriptorHash,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

export const ARRIS_PARTICIPANT_ADAPTER_ID = 'arris-resident-participant-adapter/v1'
export const ARRIS_RESIDENT_DRIVER_KIND = 'arris-resident'

/**
 * Arris compatibility product branding (T-08666 §4). Branding only: it never
 * changes HRC lifecycle semantics, selected address, incarnation/reconnect or
 * receipt behavior. The generic adapter carries these values verbatim into the
 * composed profile; there is no product-name dispatch branch.
 */
export const ARRIS_PRODUCT_ID = 'arris-resident-product'
export const ARRIS_FRONTEND = 'arris'
export const ARRIS_PROCESS_COMMAND = 'arris-resident-external'

/**
 * Product-supplied identity for one maintained external-resident participant
 * mechanism (readiness contract §4: `{productId, profilePath, driverKind,
 * hostDescriptor}`). `productId` selects product branding/profile only.
 * `frontend`/`processCommand` are the product's harness labels. `profilePath`
 * is the product's installed relative profile, carried opaquely in labels and
 * the driver spec. `driverKind` defaults to the one maintained
 * `arris-resident` control contract. The per-request host descriptor still
 * arrives via evidence (`hostDescriptor`), exactly as before.
 */
export type ResidentProductConfig = {
  productId: string
  frontend: string
  processCommand: string
  profilePath?: string | undefined
  driverKind?: string | undefined
}

export type ResidentParticipantAdapterOptions = {
  workspaceCwd: string
  /** Stable logical participant key. It must not be derived from a host process lifetime. */
  participantKey?: string | undefined
  adapterId?: string | undefined
  product: ResidentProductConfig
}

export type ValidatedResidentProduct = {
  productId: string
  frontend: string
  processCommand: string
  driverKind: string
  profilePath?: string | undefined
}

function validatedProduct(product: ResidentProductConfig): ValidatedResidentProduct {
  if (typeof product.productId !== 'string' || product.productId.length === 0) {
    throw new Error('resident product config requires a non-empty productId')
  }
  if (typeof product.frontend !== 'string' || product.frontend.length === 0) {
    throw new Error('resident product config requires a non-empty frontend')
  }
  if (typeof product.processCommand !== 'string' || product.processCommand.length === 0) {
    throw new Error('resident product config requires a non-empty processCommand')
  }
  const driverKind = product.driverKind ?? ARRIS_RESIDENT_DRIVER_KIND
  if (typeof driverKind !== 'string' || driverKind.length === 0) {
    throw new Error('resident product config requires a non-empty driverKind')
  }
  // One maintained mechanism: productId selects branding/profile only and
  // never changes HRC lifecycle semantics, so a second driver kind — with its
  // own lifecycle — is not selectable here. The field stays declared
  // configuration (auditable alongside productId/profilePath) with one
  // supported value; anything else refuses explicitly at construction instead
  // of composing a start request the wire validator or broker must reject.
  if (driverKind !== ARRIS_RESIDENT_DRIVER_KIND) {
    throw new Error(
      `resident product config driverKind must be the maintained '${ARRIS_RESIDENT_DRIVER_KIND}'`
    )
  }
  if (product.profilePath !== undefined) {
    if (typeof product.profilePath !== 'string' || product.profilePath.length === 0) {
      throw new Error('resident product config profilePath must be a non-empty string')
    }
    if (isAbsolute(product.profilePath)) {
      throw new Error('resident product config profilePath must be an installed relative path')
    }
  }
  return {
    productId: product.productId,
    frontend: product.frontend,
    processCommand: product.processCommand,
    driverKind,
    ...(product.profilePath !== undefined ? { profilePath: product.profilePath } : {}),
  }
}

/** Arris-compatible product defaults; the existing Arris configuration. */
export function arrisProductConfig(): ResidentProductConfig {
  return {
    productId: ARRIS_PRODUCT_ID,
    frontend: ARRIS_FRONTEND,
    processCommand: ARRIS_PROCESS_COMMAND,
    driverKind: ARRIS_RESIDENT_DRIVER_KIND,
  }
}

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

function stableId(prefix: 'descriptor' | 'compatibility', value: unknown): string {
  const hash = createCanonicalHasher().hash(value, {
    timestampMode: 'omit-ephemeral',
  }).value
  return `${prefix}_${hash.slice(0, 32)}`
}

function buildDescriptor(
  adapterId: string,
  product: ValidatedResidentProduct,
  request: ParticipantAdapterPreparationRequest,
  preparation: ArrisParticipantPreparation
): ParticipantBrokerDescriptor {
  const startRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1' as const,
      invocationId: request.identity.invocationId,
      labels: {
        adapter: adapterId,
        participantClass: request.classId,
        arrisHostIncarnation: preparation.hostIncarnationId,
        productId: product.productId,
        ...(product.profilePath !== undefined ? { productProfile: product.profilePath } : {}),
      },
      harness: {
        frontend: product.frontend,
        provider: 'openai',
        driver: product.driverKind,
      },
      process: {
        command: product.processCommand,
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
        kind: product.driverKind,
        descriptorPath: preparation.descriptorPath,
        hostIncarnationId: preparation.hostIncarnationId,
        hostLifecycleOwner: preparation.lifecycleOwner,
        launchId: preparation.launchId,
        ...(product.profilePath !== undefined ? { profilePath: product.profilePath } : {}),
      },
      correlation: {
        runtimeId: String(request.identity.runtimeId),
        hostSessionId: String(request.identity.hostSessionId),
        generation: String(request.identity.generation),
        invocationId: String(request.identity.invocationId),
      },
    },
  }
  const descriptorId = stableId('descriptor', {
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
  const descriptor: ParticipantBrokerDescriptor = {
    schemaVersion: 'participant-broker-descriptor/v1',
    descriptorId: descriptorId as ParticipantBrokerDescriptor['descriptorId'],
    descriptorHash: '',
    compatibilityHash,
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
        // Broker stop detaches its bridge. Host stop authority is a separate,
        // explicit managed-host control and is never inferred from this driver.
        stop: 'optional',
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
    brokerDriver: product.driverKind,
    brokerOwnership:
      request.join === 'participant-served' ? 'participant-owned-process' : 'hrc-owned-process',
    harnessInvocation: {
      startRequest,
      specHash: neutralSpecHash(startRequest.spec),
      startRequestHash: neutralStartRequestHash(startRequest),
    },
    continuation: {
      broker: {
        // Neutral control-protocol provider: the reused ResidentServer
        // descriptor/control/event contract, not product branding. Preserved
        // for every product so reconnect continuity keys stay comparable.
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
  const descriptorHash = neutralParticipantBrokerDescriptorHash(descriptor)
  const startRequestHash = descriptor.harnessInvocation.startRequestHash
  return {
    ...descriptor,
    descriptorHash,
    harnessInvocation: {
      ...descriptor.harnessInvocation,
      startRequest: {
        ...startRequest,
        spec: {
          ...startRequest.spec,
          correlation: {
            ...startRequest.spec.correlation,
            startRequestHash,
            selectedProfileHash: descriptorHash,
          },
        },
      },
    },
  }
}

function admissionPending(reason: string) {
  return { status: 'pending' as const, reason }
}

/**
 * Generic adapter for one externally served resident host (readiness
 * contract §4). One maintained mechanism: readiness, host identity and
 * descriptor/control verification are identical for every product; only the
 * declared product branding in the composed profile varies. No product-name
 * dispatch branch, no driver copy, no lifecycle fork.
 */
export function createResidentParticipantAdapter(
  options: ResidentParticipantAdapterOptions
): ParticipantAdapter {
  const adapterId = options.adapterId ?? ARRIS_PARTICIPANT_ADAPTER_ID
  const product = validatedProduct(options.product)
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
        descriptor: buildDescriptor(adapterId, product, request, preparation),
      }
    },
  }
}

/**
 * Static production adapter for one externally served Arris resident host.
 * Arris-compatible wrapper over the generic mechanism with the historical
 * product defaults; behavior and wire identifiers are unchanged.
 */
export function createArrisParticipantAdapter(
  options: ArrisParticipantAdapterOptions
): ParticipantAdapter {
  return createResidentParticipantAdapter({
    workspaceCwd: options.workspaceCwd,
    ...(options.participantKey !== undefined ? { participantKey: options.participantKey } : {}),
    ...(options.adapterId !== undefined ? { adapterId: options.adapterId } : {}),
    product: arrisProductConfig(),
  })
}
