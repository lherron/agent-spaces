import type {
  ParticipantAdapter,
  ParticipantAdapterAdmissionRequest,
  ParticipantAdapterPreparationRequest,
} from 'spaces-runtime-contracts'
import {
  type AdmitDesktopRegistrationRequest,
  type DesktopIdentityRequest,
  admitDesktopRegistration,
  resolveDesktopIdentity,
} from './desktop-native-identity.js'
import {
  type CodexDesktopObserverDescriptorFailure,
  buildCodexDesktopObserverDescriptor,
} from './desktop-observer-preparation.js'

export const CODEX_DESKTOP_PARTICIPANT_ADAPTER_ID = 'codex-desktop-participant-adapter/v1'
export const CODEX_DESKTOP_PARTICIPANT_CLASS = 'codex-desktop'

export type CodexDesktopParticipantEvidence = {
  schema: 'codex-desktop.participant-evidence/1'
  nativeThreadId: string
  reported: { codexHome?: string; sqliteHome?: string; rolloutPath?: string }
  fallbackHomeDir: string
  reportedWorkspaceCwd?: string
  reportedBundleExecutable?: string
  operatorBundleExecutable?: string
  projectRoot: string
  nativeAttemptStorePath: string
}

export type CodexDesktopParticipantPreparation = {
  schema: 'codex-desktop.participant-preparation/1'
  nativeThreadId: string
  homeIdentity: string
  sqliteHome: string
  registrationKey: string
  rolloutPath: string
  workspaceCwd: string
  reportedBundleExecutable?: string
  operatorBundleExecutable?: string
  projectRoot: string
  nativeAttemptStorePath: string
}

export type CodexDesktopParticipantContinuityEvidence = {
  schema: 'codex-desktop.host-continuity/1'
  home_identity: string
  thread_id: string
  registration_key: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const EVIDENCE_KEYS = [
  'schema',
  'nativeThreadId',
  'reported',
  'fallbackHomeDir',
  'reportedWorkspaceCwd',
  'reportedBundleExecutable',
  'operatorBundleExecutable',
  'projectRoot',
  'nativeAttemptStorePath',
]

function parseEvidence(value: unknown): CodexDesktopParticipantEvidence | undefined {
  if (!isRecord(value)) return undefined
  if (value['schema'] !== 'codex-desktop.participant-evidence/1') return undefined
  if (Object.keys(value).some((key) => !EVIDENCE_KEYS.includes(key))) return undefined
  if (typeof value['nativeThreadId'] !== 'string' || value['nativeThreadId'].length === 0) {
    return undefined
  }
  if (!isRecord(value['reported'])) return undefined
  const reported = value['reported']
  for (const field of ['codexHome', 'sqliteHome', 'rolloutPath'] as const) {
    if (reported[field] !== undefined && typeof reported[field] !== 'string') return undefined
  }
  if (typeof value['fallbackHomeDir'] !== 'string' || value['fallbackHomeDir'].length === 0) {
    return undefined
  }
  for (const field of [
    'reportedWorkspaceCwd',
    'reportedBundleExecutable',
    'operatorBundleExecutable',
    'projectRoot',
    'nativeAttemptStorePath',
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined
  }
  if (typeof value['projectRoot'] !== 'string' || value['projectRoot'].length === 0) {
    return undefined
  }
  if (
    typeof value['nativeAttemptStorePath'] !== 'string' ||
    value['nativeAttemptStorePath'].length === 0
  ) {
    return undefined
  }
  return value as CodexDesktopParticipantEvidence
}

const PREPARATION_KEYS = [
  'schema',
  'nativeThreadId',
  'homeIdentity',
  'sqliteHome',
  'registrationKey',
  'rolloutPath',
  'workspaceCwd',
  'reportedBundleExecutable',
  'operatorBundleExecutable',
  'projectRoot',
  'nativeAttemptStorePath',
]

function parsePreparation(value: unknown): CodexDesktopParticipantPreparation | undefined {
  if (!isRecord(value)) return undefined
  if (value['schema'] !== 'codex-desktop.participant-preparation/1') return undefined
  if (Object.keys(value).some((key) => !PREPARATION_KEYS.includes(key))) return undefined
  for (const field of [
    'nativeThreadId',
    'homeIdentity',
    'sqliteHome',
    'registrationKey',
    'rolloutPath',
    'workspaceCwd',
    'projectRoot',
    'nativeAttemptStorePath',
  ] as const) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) return undefined
  }
  for (const field of ['reportedBundleExecutable', 'operatorBundleExecutable'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined
  }
  return value as CodexDesktopParticipantPreparation
}

const REJECTED_CODES: ReadonlySet<CodexDesktopObserverDescriptorFailure['code']> = new Set([
  'native_thread_mismatch',
  'rollout_home_mismatch',
  'rollout_archived',
  'bundle_unresolved',
  'observer_plan_invalid',
])

function pending(reason: string) {
  return { status: 'pending' as const, reason }
}

export function createCodexDesktopParticipantAdapter(options?: {
  adapterId?: string | undefined
}): ParticipantAdapter {
  const adapterId = options?.adapterId ?? CODEX_DESKTOP_PARTICIPANT_ADAPTER_ID
  return {
    adapterId,
    async admit(request: ParticipantAdapterAdmissionRequest) {
      const evidence = parseEvidence(request.evidence)
      if (evidence === undefined) return pending('codex_desktop_evidence_invalid')
      const identityRequest: DesktopIdentityRequest = {
        schemaVersion: 'aspc-resolve-desktop-identity-request/v1',
        nativeThreadId: evidence.nativeThreadId,
        reported: {
          ...(evidence.reported.codexHome === undefined
            ? {}
            : { codexHome: evidence.reported.codexHome }),
          ...(evidence.reported.sqliteHome === undefined
            ? {}
            : { sqliteHome: evidence.reported.sqliteHome }),
          ...(evidence.reported.rolloutPath === undefined
            ? {}
            : { rolloutPath: evidence.reported.rolloutPath }),
        },
        fallbackHomeDir: evidence.fallbackHomeDir,
      }
      const resolved = await resolveDesktopIdentity(identityRequest)
      const admissionRequest: AdmitDesktopRegistrationRequest = {
        identity: resolved.identity,
        ...(evidence.reported.rolloutPath === undefined
          ? {}
          : { rolloutPath: evidence.reported.rolloutPath }),
        ...(evidence.reportedWorkspaceCwd === undefined
          ? {}
          : { reportedWorkspaceCwd: evidence.reportedWorkspaceCwd }),
      }
      const admission = await admitDesktopRegistration(admissionRequest)
      if (admission.verdict !== 'admitted' || admission.admitted === undefined) {
        const reason =
          admission.verdict === 'pending' && admission.pending !== undefined
            ? admission.pending.reason
            : 'unknown'
        return pending(`codex_desktop_${reason}`)
      }
      const preparation: CodexDesktopParticipantPreparation = {
        schema: 'codex-desktop.participant-preparation/1',
        nativeThreadId: resolved.identity.nativeThreadId,
        homeIdentity: resolved.identity.homeIdentity,
        sqliteHome: resolved.identity.sqliteHome,
        registrationKey: resolved.identity.registrationKey,
        rolloutPath: admission.admitted.rolloutPath,
        workspaceCwd: admission.admitted.workspaceCwd,
        ...(evidence.reportedBundleExecutable === undefined
          ? {}
          : { reportedBundleExecutable: evidence.reportedBundleExecutable }),
        ...(evidence.operatorBundleExecutable === undefined
          ? {}
          : { operatorBundleExecutable: evidence.operatorBundleExecutable }),
        projectRoot: evidence.projectRoot,
        nativeAttemptStorePath: evidence.nativeAttemptStorePath,
      }
      const continuityEvidence: CodexDesktopParticipantContinuityEvidence = {
        schema: 'codex-desktop.host-continuity/1',
        home_identity: resolved.identity.homeIdentity,
        thread_id: resolved.identity.nativeThreadId,
        registration_key: resolved.identity.registrationKey,
      }
      return {
        status: 'admitted',
        participantKey: resolved.identity.registrationKey,
        workspaceCwd: admission.admitted.workspaceCwd,
        preparation: preparation as never,
        continuityEvidence: continuityEvidence as never,
      }
    },
    async prepare(request: ParticipantAdapterPreparationRequest) {
      const preparation = parsePreparation(request.preparation)
      if (preparation === undefined) return pending('codex_desktop_preparation_invalid')
      const built = buildCodexDesktopObserverDescriptor({
        registration: {
          registrationKey: preparation.registrationKey,
          homeIdentity: preparation.homeIdentity,
          rolloutPath: preparation.rolloutPath,
          nativeThreadId: preparation.nativeThreadId,
          ...(preparation.reportedBundleExecutable === undefined
            ? {}
            : { reportedBundleExecutable: preparation.reportedBundleExecutable }),
          projectRoot: preparation.projectRoot,
          sqliteHome: preparation.sqliteHome,
        },
        ...(preparation.operatorBundleExecutable === undefined
          ? {}
          : { operatorBundleExecutable: preparation.operatorBundleExecutable }),
        identity: {
          requestId: String(request.identity.requestId),
          operationId: String(request.identity.operationId),
          invocationId: String(request.identity.invocationId),
          runtimeId: String(request.identity.runtimeId),
          hostSessionId: String(request.identity.hostSessionId),
          generation: request.identity.generation,
          ...(request.identity.runId === undefined
            ? {}
            : { runId: String(request.identity.runId) }),
          ...(request.identity.traceId === undefined
            ? {}
            : { traceId: String(request.identity.traceId) }),
        },
        brokerOwnership: 'participant-owned-process',
        nativeAttemptStorePath: preparation.nativeAttemptStorePath,
      })
      if (!built.ok) {
        if (REJECTED_CODES.has(built.code)) {
          return { status: 'rejected' as const, reason: `codex_desktop_${built.code}` }
        }
        return pending(`codex_desktop_${built.code}`)
      }
      return { status: 'prepared' as const, descriptor: built.descriptor }
    },
  }
}
