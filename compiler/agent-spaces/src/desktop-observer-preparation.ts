import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  type BrokerExecutionProfile,
  type CompiledRuntimePlan,
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  createCanonicalHasher,
  hashNeutralStartRequest,
  neutralBrokerExecutionProfileHash,
  neutralSpecHash,
  neutralStartRequestHash,
  validateBrokerExecutionProfile,
} from 'spaces-runtime-contracts'

const MAX_HEADER_BYTES = 256 * 1024
const DEFAULT_DESKTOP_BUNDLE = '/Applications/ChatGPT.app/Contents/Resources/codex'

type DesktopRecoveryBoundary = {
  sourceKind?: string
  sourceEpoch?: string
  furthestCommittedRecord?: {
    rawRecordId: string
    byteOffset: number
    line?: number
    rawSha256?: string
    nativeType?: string
  }
  earliestPendingRecord?: { rawRecordId: string; byteOffset: number }
  committedProjections: Array<{
    seq: number
    type: string
    turnId?: string
    itemId?: string
    nativeId?: string
    rawRecordId?: string
  }>
  appliedThroughSeq: number
  empty: boolean
}

type DesktopObserverRequest = {
  registration: {
    registrationKey: string
    agentId: string
    projectId: string
    scopeRef: string
    laneRef: string
    hostSessionId: string
    generation: number
    homeIdentity: string
    rolloutPath?: string
    nativeThreadId: string
    reportedBundleExecutable?: string
    projectRoot: string
    sqliteHome: string
  }
  operatorBundleExecutable?: string
  hostingIdentity: { runtimeId: string; runId: string; hostSessionId: string; generation: number }
  recoveryBoundary?: DesktopRecoveryBoundary
  nativeAttemptStorePath: string
}

function notPrepared(
  code:
    | 'rollout_unavailable'
    | 'rollout_archived'
    | 'rollout_home_mismatch'
    | 'native_metadata_unparsable'
    | 'native_thread_mismatch'
    | 'bundle_unresolved'
    | 'observer_plan_invalid',
  detail: string
) {
  return {
    schemaVersion: 'aspc-prepare-desktop-observer-response/v1' as const,
    ok: false as const,
    notPrepared: { code, detail },
  }
}

function stable(prefix: string, value: unknown): string {
  const hash = createCanonicalHasher().hash(value, { timestampMode: 'omit-ephemeral' }).value
  return `${prefix}_${hash.slice(0, 32)}`
}

function hashValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex')
}

function firstLine(path: string): string {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES + 1)
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytesRead).indexOf(10)
    if (newline < 0 || newline > MAX_HEADER_BYTES) throw new Error('oversized header')
    return buffer.subarray(0, newline).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export async function prepareDesktopObserver(request: DesktopObserverRequest) {
  const registration = request.registration
  if (!registration.rolloutPath) {
    return notPrepared('rollout_unavailable', 'No Desktop rollout path is recorded')
  }
  let home: string
  let rollout: string
  try {
    home = realpathSync(registration.homeIdentity)
    rollout = realpathSync(registration.rolloutPath)
  } catch (error) {
    return notPrepared(
      'rollout_unavailable',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (rollout !== home && !rollout.startsWith(`${home}${sep}`)) {
    return notPrepared('rollout_home_mismatch', 'Rollout is outside the registered Desktop home')
  }
  if (rollout.includes(`${sep}archived_sessions${sep}`)) {
    return notPrepared('rollout_archived', 'Archived Desktop history cannot be observed')
  }
  try {
    const metadata = JSON.parse(firstLine(rollout))
    const metadataThreadId = metadata?.payload?.session_id ?? metadata?.payload?.id
    if (
      typeof metadataThreadId !== 'string' ||
      metadataThreadId.toLowerCase() !== registration.nativeThreadId.toLowerCase()
    ) {
      return notPrepared('native_thread_mismatch', 'Rollout thread does not match registration')
    }
  } catch (error) {
    return notPrepared(
      'native_metadata_unparsable',
      error instanceof Error ? error.message : String(error)
    )
  }
  const bundleExecutable = [
    registration.reportedBundleExecutable,
    request.operatorBundleExecutable,
    DEFAULT_DESKTOP_BUNDLE,
  ].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate))
  if (!bundleExecutable) {
    return notPrepared('bundle_unresolved', 'Desktop bundle executable is unavailable')
  }
  if (!isAbsolute(request.nativeAttemptStorePath)) {
    return notPrepared('observer_plan_invalid', 'Native attempt store path must be absolute')
  }

  const invocationId = stable('invocation', request) as NonNullable<
    InvocationStartRequest['spec']['invocationId']
  >
  const startRequest: InvocationStartRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1',
      invocationId,
      harness: { frontend: 'codex-desktop', provider: 'openai', driver: 'codex-desktop' },
      process: {
        command: 'external-codex-desktop',
        args: [],
        cwd: registration.projectRoot,
        lockedEnv: {},
        harnessTransport: { kind: 'pipes' },
      },
      interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
      driver: {
        kind: 'codex-desktop',
        bundleExecutable,
        codexHome: registration.homeIdentity,
        sqliteHome: registration.sqliteHome,
        threadId: registration.nativeThreadId,
        rolloutPath: registration.rolloutPath,
        nativeAttemptStorePath: request.nativeAttemptStorePath,
        recoveryBoundary: request.recoveryBoundary,
      },
      correlation: {
        runtimeId: request.hostingIdentity.runtimeId,
        runId: request.hostingIdentity.runId,
        hostSessionId: request.hostingIdentity.hostSessionId,
        generation: String(request.hostingIdentity.generation),
        invocationId,
      },
    },
  }
  const specHash = neutralSpecHash(startRequest.spec)
  const startRequestHash = neutralStartRequestHash(startRequest)
  const requestId = stable(
    'request',
    request
  ) as BrokerExecutionProfile['observability']['correlation']['requestId']
  const operationId = stable(
    'operation',
    request
  ) as BrokerExecutionProfile['observability']['correlation']['operationId']
  const traceId = stable('trace', request) as NonNullable<
    BrokerExecutionProfile['observability']['correlation']['traceId']
  >
  const selectedProfile: BrokerExecutionProfile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: `profile_${hashValue({
      driver: 'codex-desktop',
      startRequest: hashNeutralStartRequest(startRequest),
    }).slice(0, 32)}` as BrokerExecutionProfile['profileId'],
    profileHash: '' as BrokerExecutionProfile['profileHash'],
    compatibilityHash: hashValue({
      driver: 'codex-desktop',
      threadId: registration.nativeThreadId,
      codexHome: registration.homeIdentity,
    }) as BrokerExecutionProfile['compatibilityHash'],
    kind: 'harness-broker',
    interactionMode: 'headless',
    expectedCapabilities: {
      input: {
        user: 'required',
        steer: 'forbidden',
        appendContext: 'forbidden',
        localImages: 'forbidden',
        fileRefs: 'forbidden',
        queue: 'required',
      },
      turns: { concurrency: 'single', interrupt: 'forbidden' },
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
        runtimeRetention: ['keep-alive'],
        harnessRecovery: ['none'],
        turnRetry: ['none'],
        generationFencing: 'forbidden',
        permissionCancellation: 'forbidden',
      },
    },
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-desktop',
    brokerOwnership: 'hrc-owned-process',
    harnessInvocation: {
      startRequest,
      specHash,
      startRequestHash,
    },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {
        ...DEFAULT_CODEX_BROKER_INPUT_POLICY,
        supportedKinds: ['user'],
        attachmentPolicy: { localImages: false, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' },
    },
    observability: {
      correlation: {
        requestId,
        operationId,
        invocationId,
        traceId,
        ...request.hostingIdentity,
      } as BrokerExecutionProfile['observability']['correlation'],
    },
  }
  selectedProfile.profileHash = neutralBrokerExecutionProfileHash(selectedProfile)
  const profileFindings = validateBrokerExecutionProfile(selectedProfile)
  if (profileFindings.length > 0) {
    return notPrepared(
      'observer_plan_invalid',
      profileFindings.map((finding) => finding.message).join('; ')
    )
  }

  const identity: CompiledRuntimePlan['identity'] = {
    requestId: selectedProfile.observability.correlation.requestId,
    operationId: selectedProfile.observability.correlation.operationId,
    hostSessionId: request.hostingIdentity
      .hostSessionId as CompiledRuntimePlan['identity']['hostSessionId'],
    generation: request.hostingIdentity.generation,
    runtimeId: request.hostingIdentity.runtimeId as CompiledRuntimePlan['identity']['runtimeId'],
    invocationId,
    runId: request.hostingIdentity.runId as NonNullable<CompiledRuntimePlan['identity']['runId']>,
    traceId: traceId as NonNullable<CompiledRuntimePlan['identity']['traceId']>,
  }
  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: 'codex-desktop-observer/1' },
    compileId: stable('compile', request) as CompiledRuntimePlan['compileId'],
    createdAt: '1970-01-01T00:00:00.000Z',
    identity,
    placement: {
      kind: 'external-native-desktop',
      root: registration.projectRoot,
      registrationKey: registration.registrationKey,
      agentId: registration.agentId,
      projectId: registration.projectId,
      scopeRef: registration.scopeRef,
      laneRef: registration.laneRef,
    },
    resolvedBundle: {
      bundleIdentity: `codex-desktop:${bundleExecutable}`,
      root: registration.homeIdentity,
    },
    omitPriming: true,
    harness: {
      family: 'codex' as const,
      runtime: 'codex-desktop' as const,
      provider: 'openai' as const,
    },
    model: { provider: 'openai' as const, modelId: 'codex-desktop' },
    executionProfiles: [selectedProfile],
    artifacts: { bundleIdentity: `codex-desktop:${bundleExecutable}` },
    lockedEnv: { lockedEnvKeys: [] },
    diagnostics: [],
  }
  const plan: CompiledRuntimePlan = {
    ...planMaterial,
    planHash: stable('plan', planMaterial),
  }
  return {
    schemaVersion: 'aspc-prepare-desktop-observer-response/v1' as const,
    ok: true as const,
    plan,
    selectedProfile,
    startRequest,
    dispatchRequest: { startRequest },
    diagnostics: [],
  }
}
