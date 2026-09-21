import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  type BrokerExecutionProfile,
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
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

export type CodexDesktopObserverIdentity = {
  requestId: string
  operationId: string
  invocationId: string
  runtimeId: string
  hostSessionId: string
  generation: number
  runId?: string | undefined
  traceId?: string | undefined
}

export type CodexDesktopObserverProfileRequest = {
  registration: {
    registrationKey: string
    homeIdentity: string
    rolloutPath?: string
    nativeThreadId: string
    reportedBundleExecutable?: string
    projectRoot: string
    sqliteHome: string
  }
  operatorBundleExecutable?: string
  identity: CodexDesktopObserverIdentity
  brokerOwnership: BrokerExecutionProfile['brokerOwnership']
  recoveryBoundary?: DesktopRecoveryBoundary
  nativeAttemptStorePath: string
}

export type CodexDesktopObserverProfileBuilt = {
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
}

export type CodexDesktopObserverProfileFailure = {
  code:
    | 'rollout_unavailable'
    | 'rollout_archived'
    | 'rollout_home_mismatch'
    | 'native_metadata_unparsable'
    | 'native_thread_mismatch'
    | 'bundle_unresolved'
    | 'observer_plan_invalid'
  detail: string
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

export function buildCodexDesktopObserverProfile(request: CodexDesktopObserverProfileRequest):
  | {
      ok: true
      profile: BrokerExecutionProfile
      startRequest: InvocationStartRequest
      bundleExecutable: string
    }
  | { ok: false; code: CodexDesktopObserverProfileFailure['code']; detail: string } {
  const registration = request.registration
  if (!registration.rolloutPath) {
    return {
      ok: false as const,
      code: 'rollout_unavailable',
      detail: 'No Desktop rollout path is recorded',
    }
  }
  let home: string
  let rollout: string
  try {
    home = realpathSync(registration.homeIdentity)
    rollout = realpathSync(registration.rolloutPath)
  } catch (error) {
    return {
      ok: false as const,
      code: 'rollout_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (rollout !== home && !rollout.startsWith(`${home}${sep}`)) {
    return {
      ok: false as const,
      code: 'rollout_home_mismatch',
      detail: 'Rollout is outside the registered Desktop home',
    }
  }
  if (rollout.includes(`${sep}archived_sessions${sep}`)) {
    return {
      ok: false as const,
      code: 'rollout_archived',
      detail: 'Archived Desktop history cannot be observed',
    }
  }
  try {
    const metadata = JSON.parse(firstLine(rollout))
    const metadataThreadId = metadata?.payload?.session_id ?? metadata?.payload?.id
    if (
      typeof metadataThreadId !== 'string' ||
      metadataThreadId.toLowerCase() !== registration.nativeThreadId.toLowerCase()
    ) {
      return {
        ok: false as const,
        code: 'native_thread_mismatch',
        detail: 'Rollout thread does not match registration',
      }
    }
  } catch (error) {
    return {
      ok: false as const,
      code: 'native_metadata_unparsable',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  const bundleExecutable = [
    registration.reportedBundleExecutable,
    request.operatorBundleExecutable,
    DEFAULT_DESKTOP_BUNDLE,
  ].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate))
  if (!bundleExecutable) {
    return {
      ok: false as const,
      code: 'bundle_unresolved',
      detail: 'Desktop bundle executable is unavailable',
    }
  }
  if (!isAbsolute(request.nativeAttemptStorePath)) {
    return {
      ok: false as const,
      code: 'observer_plan_invalid',
      detail: 'Native attempt store path must be absolute',
    }
  }

  const invocationId = request.identity.invocationId as NonNullable<
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
        runtimeId: request.identity.runtimeId,
        ...(request.identity.runId === undefined ? {} : { runId: request.identity.runId }),
        hostSessionId: request.identity.hostSessionId,
        generation: String(request.identity.generation),
        invocationId,
      },
    },
  }
  const specHash = neutralSpecHash(startRequest.spec)
  const startRequestHash = neutralStartRequestHash(startRequest)
  const requestId = request.identity
    .requestId as BrokerExecutionProfile['observability']['correlation']['requestId']
  const operationId = request.identity
    .operationId as BrokerExecutionProfile['observability']['correlation']['operationId']
  const traceId = request.identity.traceId as
    | BrokerExecutionProfile['observability']['correlation']['traceId']
    | undefined
  const unhashedProfile: BrokerExecutionProfile = {
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
    brokerOwnership: request.brokerOwnership,
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
        hostSessionId: request.identity
          .hostSessionId as BrokerExecutionProfile['observability']['correlation']['hostSessionId'],
        generation: request.identity.generation,
        runtimeId: request.identity
          .runtimeId as BrokerExecutionProfile['observability']['correlation']['runtimeId'],
        invocationId,
        ...(request.identity.runId === undefined
          ? {}
          : {
              runId: request.identity.runId as NonNullable<
                BrokerExecutionProfile['observability']['correlation']['runId']
              >,
            }),
        ...(traceId === undefined ? {} : { traceId }),
      },
    },
  }
  const profileHash = neutralBrokerExecutionProfileHash(unhashedProfile)
  const patchStartRequestHash = unhashedProfile.harnessInvocation.startRequestHash
  const patchedStartRequest: InvocationStartRequest = {
    ...startRequest,
    spec: {
      ...startRequest.spec,
      correlation: {
        ...startRequest.spec.correlation,
        startRequestHash: patchStartRequestHash,
        selectedProfileHash: profileHash,
      },
    },
  }
  const selectedProfile: BrokerExecutionProfile = {
    ...unhashedProfile,
    profileHash,
    harnessInvocation: {
      ...unhashedProfile.harnessInvocation,
      startRequest: patchedStartRequest,
    },
  }
  const profileFindings = validateBrokerExecutionProfile(selectedProfile)
  if (profileFindings.length > 0) {
    return {
      ok: false as const,
      code: 'observer_plan_invalid',
      detail: profileFindings.map((finding) => finding.message).join('; '),
    }
  }
  return {
    ok: true as const,
    profile: selectedProfile,
    startRequest: patchedStartRequest,
    bundleExecutable,
  }
}
