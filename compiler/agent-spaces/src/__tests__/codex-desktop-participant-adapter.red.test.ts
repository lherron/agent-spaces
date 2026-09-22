import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateParticipantAdapterPreparation } from 'spaces-runtime-contracts'
import { createCodexDesktopParticipantAdapter } from '../codex-desktop-participant-adapter.js'

const THREAD_ID = '0199abcd-1234-5678-9abc-def012345678'

async function desktopHome(options: { threadSource?: string; originator?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-desktop-adapter-'))
  const codexHome = join(dir, 'codex-home')
  const rolloutDir = join(codexHome, 'sessions', '2026', '09')
  await mkdir(rolloutDir, { recursive: true })
  const rolloutPath = join(rolloutDir, `${THREAD_ID}.jsonl`)
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: THREAD_ID,
        source: 'vscode',
        thread_source: options.threadSource ?? 'user',
        originator: options.originator ?? 'codex-desktop',
        cwd: join(dir, 'workspace'),
        cli_version: '1.0-test',
      },
    })}\n{"type":"other"}\n`
  )
  const bundleExecutable = join(dir, 'codex-bundle')
  await writeFile(bundleExecutable, '#!/bin/sh\n')
  return { dir, codexHome, rolloutPath, bundleExecutable }
}

const identity = {
  requestId: 'request:desktop-adapter' as never,
  operationId: 'runtimeOperation:desktop-adapter' as never,
  hostSessionId: 'hostSession:desktop-adapter' as never,
  generation: 3,
  runtimeId: 'runtime:desktop-adapter' as never,
  invocationId: 'invocation:desktop-adapter' as never,
}

describe('codex-desktop participant adapter', () => {
  test('admits a user Desktop thread and prepares with HRC-minted identity echoed', async () => {
    const home = await desktopHome()
    const adapter = createCodexDesktopParticipantAdapter()
    const admission = await adapter.admit({
      classId: 'codex-desktop',
      join: 'participant-served',
      evidence: {
        schema: 'codex-desktop.participant-evidence/1',
        nativeThreadId: THREAD_ID,
        reported: { codexHome: home.codexHome, rolloutPath: home.rolloutPath },
        fallbackHomeDir: home.dir,
        reportedBundleExecutable: home.bundleExecutable,
        projectRoot: join(home.dir, 'workspace'),
        nativeAttemptStorePath: join(home.dir, 'attempts.sqlite'),
      },
    })
    expect(admission.status).toBe('admitted')
    if (admission.status !== 'admitted') return
    const request = {
      classId: 'codex-desktop',
      join: 'participant-served' as const,
      participantKey: admission.participantKey,
      workspaceCwd: admission.workspaceCwd,
      preparation: admission.preparation,
      identity,
      scopeRef: 'agent:stella:project:demo:task:primary-nova',
      laneRef: 'main',
      attachEpoch: 1,
    }
    const prepared = await adapter.prepare(request)
    expect(prepared.status).toBe('prepared')
    const validation = validateParticipantAdapterPreparation(request, prepared)
    expect(validation.ok).toBe(true)
    if (prepared.status !== 'prepared') return
    expect(prepared.descriptor.brokerOwnership).toBe('participant-owned-process')
    expect(prepared.descriptor.brokerDriver).toBe('codex-desktop')
    const preparation = admission.preparation as unknown as {
      homeIdentity: string
      rolloutPath: string
      sqliteHome: string
      nativeAttemptStorePath: string
    }
    expect(prepared.descriptor.harnessInvocation.startRequest.spec.driver).toMatchObject({
      kind: 'codex-desktop',
      bundleExecutable: home.bundleExecutable,
      codexHome: preparation.homeIdentity,
      sqliteHome: preparation.sqliteHome,
      threadId: THREAD_ID,
      rolloutPath: preparation.rolloutPath,
      nativeAttemptStorePath: preparation.nativeAttemptStorePath,
    })
    expect(prepared.descriptor.expectedCapabilities.input).toMatchObject({
      queue: 'required',
      steer: 'forbidden',
    })
    expect(prepared.descriptor.expectedCapabilities.turns).toMatchObject({
      interrupt: 'forbidden',
    })
    expect(prepared.descriptor.expectedCapabilities.lifecycle).toMatchObject({
      runtimeRetention: ['keep-alive'],
      harnessRecovery: ['none'],
    })
    expect(prepared.descriptor.observability.correlation).toMatchObject({
      requestId: 'request:desktop-adapter',
      operationId: 'runtimeOperation:desktop-adapter',
      runtimeId: 'runtime:desktop-adapter',
      invocationId: 'invocation:desktop-adapter',
    })
  })

  test('refuses a spawned subagent thread at admission', async () => {
    const home = await desktopHome({ threadSource: 'spawning-subagent' })
    const adapter = createCodexDesktopParticipantAdapter()
    const admission = await adapter.admit({
      classId: 'codex-desktop',
      join: 'participant-served',
      evidence: {
        schema: 'codex-desktop.participant-evidence/1',
        nativeThreadId: THREAD_ID,
        reported: { codexHome: home.codexHome, rolloutPath: home.rolloutPath },
        fallbackHomeDir: home.dir,
        projectRoot: join(home.dir, 'workspace'),
        nativeAttemptStorePath: join(home.dir, 'attempts.sqlite'),
      },
    })
    expect(admission.status).not.toBe('admitted')
  })
})
