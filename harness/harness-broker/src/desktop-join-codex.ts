import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_DESKTOP_PARTICIPANT_CLASS,
  type CodexDesktopParticipantPreparation,
  createCodexDesktopParticipantAdapter,
} from 'agent-spaces'
import { desktopStatePaths } from './desktop-join-thread.js'
import type { DesktopJoinClient } from './desktop-join.js'
import { DESKTOP_AGENT_ID, desktopScopeRef, desktopSlotTokenSequence } from './desktop-project.js'
import { createCodexDesktopDriver } from './drivers/codex-desktop/driver.js'

export type CodexDesktopJoinInput = {
  threadId: string
  codexHome: string
  rolloutPath?: string | undefined
  workspaceCwd?: string | undefined
  fallbackHomeDir?: string | undefined
  sqliteHome?: string | undefined
  reportedBundleExecutable?: string | undefined
  operatorBundleExecutable?: string | undefined
  projectRoot?: string | undefined
}

type CodexDesktopAdmission =
  | {
      admitted: true
      preparation: CodexDesktopParticipantPreparation
      participantKey: string
      workspaceCwd: string
      homeIdentity: string
    }
  | { admitted: false; reason: string; detail?: string | undefined }

export async function admitDesktopThread(input: {
  threadId: string
  codexHome: string
  rolloutPath?: string | undefined
  workspaceCwd?: string | undefined
  fallbackHomeDir?: string | undefined
  sqliteHome?: string | undefined
  reportedBundleExecutable?: string | undefined
  operatorBundleExecutable?: string | undefined
  projectRoot?: string | undefined
  nativeAttemptStorePath?: string | undefined
}): Promise<CodexDesktopAdmission> {
  const adapter = createCodexDesktopParticipantAdapter()
  const admission = await adapter.admit({
    classId: 'codex-desktop',
    join: 'participant-served',
    evidence: {
      schema: 'codex-desktop.participant-evidence/1',
      nativeThreadId: input.threadId,
      reported: {
        ...(input.codexHome === undefined ? {} : { codexHome: input.codexHome }),
        ...(input.sqliteHome === undefined ? {} : { sqliteHome: input.sqliteHome }),
        ...(input.rolloutPath === undefined ? {} : { rolloutPath: input.rolloutPath }),
      },
      fallbackHomeDir: input.fallbackHomeDir ?? process.env['HOME'] ?? tmpdir(),
      ...(input.workspaceCwd === undefined ? {} : { reportedWorkspaceCwd: input.workspaceCwd }),
      ...(input.reportedBundleExecutable === undefined
        ? {}
        : { reportedBundleExecutable: input.reportedBundleExecutable }),
      ...(input.operatorBundleExecutable === undefined
        ? {}
        : { operatorBundleExecutable: input.operatorBundleExecutable }),
      projectRoot: input.projectRoot ?? input.workspaceCwd ?? process.cwd(),
      nativeAttemptStorePath:
        input.nativeAttemptStorePath ??
        join(input.codexHome, 'hrc-desktop', input.threadId, 'native-attempts.db'),
    },
  })
  if (admission.status !== 'admitted') {
    const reason =
      admission.status === 'pending' || admission.status === 'rejected'
        ? admission.reason
        : 'unknown'
    return { admitted: false, reason }
  }
  const preparation = admission.preparation as unknown as CodexDesktopParticipantPreparation
  return {
    admitted: true,
    preparation,
    participantKey: admission.participantKey,
    workspaceCwd: admission.workspaceCwd,
    homeIdentity: preparation.homeIdentity,
  }
}

export function createCodexDesktopJoinClient(input: CodexDesktopJoinInput): DesktopJoinClient {
  return {
    sessionId: input.threadId,
    classId: CODEX_DESKTOP_PARTICIPANT_CLASS,
    agentId: DESKTOP_AGENT_ID,
    cacheIdentity: { threadId: input.threadId },
    statePaths: () => desktopStatePaths(input.codexHome, input.threadId),
    adapter: createCodexDesktopParticipantAdapter(),
    *scopeRefs(projectId) {
      for (const slot of desktopSlotTokenSequence()) {
        yield desktopScopeRef(DESKTOP_AGENT_ID, projectId, slot)
      }
    },
    createDriver: createCodexDesktopDriver,
    async admit(paths) {
      const nativeAttemptStorePath = join(paths.stateDir, 'native-attempts.db')
      const admission = await admitDesktopThread({ ...input, nativeAttemptStorePath })
      if (!admission.admitted) return admission
      return {
        ...admission,
        preparation: {
          schema: 'codex-desktop.participant-preparation/1',
          nativeThreadId: input.threadId,
          homeIdentity: admission.homeIdentity,
          sqliteHome: admission.preparation.sqliteHome,
          registrationKey: admission.preparation.registrationKey,
          rolloutPath: admission.preparation.rolloutPath,
          workspaceCwd: admission.workspaceCwd,
          ...(admission.preparation.reportedBundleExecutable === undefined
            ? {}
            : { reportedBundleExecutable: admission.preparation.reportedBundleExecutable }),
          ...(admission.preparation.operatorBundleExecutable === undefined
            ? {}
            : { operatorBundleExecutable: admission.preparation.operatorBundleExecutable }),
          projectRoot: admission.preparation.projectRoot,
          nativeAttemptStorePath,
        },
      }
    },
  }
}
