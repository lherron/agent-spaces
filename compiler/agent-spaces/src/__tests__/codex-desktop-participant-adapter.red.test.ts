import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateParticipantAdapterPreparation } from 'spaces-runtime-contracts'
import { createCodexDesktopParticipantAdapter } from '../codex-desktop-participant-adapter.js'

const THREAD_ID = '0199abcd-1234-5678-9abc-def012345678'
const OTHER_THREAD = '0199abcd-1234-5678-9abc-def012345679'

async function desktopHome(
  options: { threadSource?: string; originator?: string; source?: unknown } = {}
) {
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
        source: options.source ?? 'vscode',
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
    const home = await desktopHome({
      source: { subagent: { thread_spawn: { parent_thread_id: OTHER_THREAD } } },
    })
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
    expect(admission).toEqual({ status: 'pending', reason: 'codex_desktop_spawned_subagent' })
  })
})

/**
 * Native Desktop identity and admission (T-08577), observed through the only
 * caller left after the RPCs were retired (T-08594): the adapter's admit().
 */
describe('codex-desktop adapter native identity and admission', () => {
  const MIXED_CASE_THREAD = '018F0F3E-7D65-7C19-A2BD-5A43C86C72AB'
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 't08577-desktop-'))
    roots.push(root)
    return root
  }

  function registrationKey(home: string, thread: string): string {
    return createHash('sha256')
      .update(home, 'utf8')
      .update('\0')
      .update(thread.toLowerCase(), 'utf8')
      .digest('hex')
  }

  function sessionMeta(payload: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'session_meta',
      payload: {
        id: MIXED_CASE_THREAD,
        cwd: '/workspace/native',
        source: 'vscode',
        thread_source: 'user',
        originator: 'Codex Desktop',
        cli_version: '999.0.0',
        ...payload,
      },
    })
  }

  async function writeRollout(path: string, firstLine: string): Promise<string> {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${firstLine}\n${'x'.repeat(300_000)}\n`)
    return path
  }

  async function admit(input: {
    base: string
    reported: { codexHome?: string; sqliteHome?: string; rolloutPath?: string }
    fallbackHomeDir?: string
    reportedWorkspaceCwd?: string
  }) {
    return createCodexDesktopParticipantAdapter().admit({
      classId: 'codex-desktop',
      join: 'participant-served',
      evidence: {
        schema: 'codex-desktop.participant-evidence/1',
        nativeThreadId: MIXED_CASE_THREAD,
        reported: input.reported,
        fallbackHomeDir: input.fallbackHomeDir ?? join(input.base, 'fallback'),
        ...(input.reportedWorkspaceCwd === undefined
          ? {}
          : { reportedWorkspaceCwd: input.reportedWorkspaceCwd }),
        projectRoot: join(input.base, 'workspace'),
        nativeAttemptStorePath: join(input.base, 'attempts.sqlite'),
      },
    })
  }

  test('a symlinked reported home keys on its canonical path and keeps an explicit sqlite home', async () => {
    const base = await scratch()
    const realHome = join(base, 'real-codex-home')
    const linkedHome = join(base, 'reported-codex-home')
    const sqliteHome = join(base, 'sqlite-home-that-does-not-exist')
    await mkdir(realHome, { recursive: true })
    await symlink(realHome, linkedHome)
    const rolloutPath = await writeRollout(
      join(linkedHome, 'sessions', '2026', '09', '17', 'rollout.jsonl'),
      sessionMeta({})
    )

    const admission = await admit({
      base,
      reported: { codexHome: linkedHome, sqliteHome, rolloutPath },
    })

    const canonicalHome = await realpath(realHome)
    expect(admission).toMatchObject({
      status: 'admitted',
      participantKey: registrationKey(canonicalHome, MIXED_CASE_THREAD),
      preparation: {
        homeIdentity: canonicalHome,
        sqliteHome: resolve(sqliteHome),
        registrationKey: registrationKey(canonicalHome, MIXED_CASE_THREAD),
      },
    })
  })

  test('without a reported home the rollout tree wins, and a rollout outside sessions/ falls back to ~/.codex', async () => {
    const base = await scratch()
    const rolloutHome = join(base, 'rollout-home')
    const fallback = join(base, 'fallback-user')
    await mkdir(fallback, { recursive: true })
    const sessionsRollout = await writeRollout(
      join(rolloutHome, 'sessions', '2026', '09', '17', 'rollout.jsonl'),
      sessionMeta({})
    )
    const looseRollout = await writeRollout(join(base, 'loose', 'rollout.jsonl'), sessionMeta({}))

    const fromRollout = await admit({
      base,
      reported: { rolloutPath: sessionsRollout },
      fallbackHomeDir: fallback,
    })
    const fromFallback = await admit({
      base,
      reported: { rolloutPath: looseRollout },
      fallbackHomeDir: fallback,
    })

    const rolloutIdentity = await realpath(rolloutHome)
    const fallbackIdentity = join(await realpath(fallback), '.codex')
    expect(fromRollout).toMatchObject({
      status: 'admitted',
      participantKey: registrationKey(rolloutIdentity, MIXED_CASE_THREAD),
      preparation: { homeIdentity: rolloutIdentity },
    })
    expect(fromFallback).toMatchObject({
      status: 'admitted',
      participantKey: registrationKey(fallbackIdentity, MIXED_CASE_THREAD),
      preparation: { homeIdentity: fallbackIdentity },
    })
  })

  test('main Desktop metadata is admitted and the native cwd wins over the hook-reported cwd', async () => {
    const base = await scratch()
    const home = join(base, 'codex-home')
    const rolloutPath = await writeRollout(
      join(home, 'sessions', '2026', '09', '17', 'rollout.jsonl'),
      sessionMeta({})
    )

    const admission = await admit({
      base,
      reported: { codexHome: home, rolloutPath },
      reportedWorkspaceCwd: '/workspace/hook-report',
    })

    expect(admission).toMatchObject({
      status: 'admitted',
      workspaceCwd: '/workspace/native',
      preparation: { rolloutPath, workspaceCwd: '/workspace/native' },
    })
  })

  test.each([
    ['archived history', 'archived_sessions/rollout.jsonl', sessionMeta({}), 'archived_history'],
    [
      'an unparsable first line',
      'sessions/2026/09/17/malformed.jsonl',
      'not json',
      'native_metadata_unparsable',
    ],
    [
      'a first line over the header limit',
      'sessions/2026/09/17/oversized.jsonl',
      sessionMeta({ padding: 'x'.repeat(300_000) }),
      'native_metadata_unparsable',
    ],
    [
      'another thread',
      'sessions/2026/09/17/mismatch.jsonl',
      sessionMeta({ id: '018f0f3e-7d65-7c19-a2bd-5a43c86c72ac' }),
      'native_thread_mismatch',
    ],
    [
      'a guardian subagent',
      'sessions/2026/09/17/guardian.jsonl',
      sessionMeta({ source: { subagent: { kind: 'guardian' } }, thread_source: 'guardian_review' }),
      'spawned_subagent',
    ],
  ])('a rollout with %s stays pending', async (_name, relative, firstLine, reason) => {
    const base = await scratch()
    const home = join(base, 'codex-home')
    const rolloutPath = await writeRollout(join(home, relative), firstLine)

    expect(await admit({ base, reported: { codexHome: home, rolloutPath } })).toEqual({
      status: 'pending',
      reason: `codex_desktop_${reason}`,
    })
  })
})
