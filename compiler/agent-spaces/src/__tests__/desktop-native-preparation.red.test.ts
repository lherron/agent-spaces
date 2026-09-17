/**
 * T-08577 behavior reds for ASP-owned Codex Desktop native interpretation.
 *
 * Calls stay on the existing public `agent-spaces` module namespace. The
 * additive functions are looked up at runtime so the baseline collects and
 * fails assertions instead of failing module loading. Fixtures reproduce the
 * provider-native bytes HRC interprets today: UUID identity, canonical homes,
 * the NUL-delimited key hash, and the first `session_meta` line.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as agentSpaces from '../index.js'

type AsyncOperation = (request: Record<string, unknown>) => unknown | Promise<unknown>
type OperationResponse = Record<string, unknown>

const THREAD = '018F0F3E-7D65-7C19-A2BD-5A43C86C72AB'
const OTHER_THREAD = '018f0f3e-7d65-7c19-a2bd-5a43c86c72ac'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 't08577-desktop-'))
  roots.push(value)
  return value
}

function requireOperation(name: string): AsyncOperation {
  const candidate = (agentSpaces as unknown as Record<string, unknown>)[name]
  expect(typeof candidate, `agent-spaces must export ${name}`).toBe('function')
  return candidate as AsyncOperation
}

async function invoke(name: string, request: Record<string, unknown>): Promise<OperationResponse> {
  const result = await requireOperation(name)(request)
  expect(typeof result).toBe('object')
  expect(result).not.toBeNull()
  return result as OperationResponse
}

function expectedKey(home: string, thread: string): string {
  return createHash('sha256')
    .update(home, 'utf8')
    .update('\0')
    .update(thread.toLowerCase(), 'utf8')
    .digest('hex')
}

function identityRequest(input: {
  codexHome?: string
  sqliteHome?: string
  rolloutPath?: string
  fallbackHomeDir: string
}): Record<string, unknown> {
  return {
    schemaVersion: 'aspc-resolve-desktop-identity-request/v1',
    nativeThreadId: THREAD,
    reported: {
      ...(input.codexHome !== undefined ? { codexHome: input.codexHome } : {}),
      ...(input.sqliteHome !== undefined ? { sqliteHome: input.sqliteHome } : {}),
      ...(input.rolloutPath !== undefined ? { rolloutPath: input.rolloutPath } : {}),
    },
    fallbackHomeDir: input.fallbackHomeDir,
  }
}

function admittedLine(thread = THREAD, cwd = '/workspace/native'): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id: thread,
      cwd,
      source: 'vscode',
      thread_source: 'user',
      originator: 'Codex Desktop',
      cli_version: '999.0.0',
    },
  })
}

describe('Desktop native identity and admission (T-08577)', () => {
  test('control: the existing compiler client public seam still loads', () => {
    expect(typeof agentSpaces.createAgentSpacesClient).toBe('function')
    expect(typeof agentSpaces.createAgentSpacesClient().buildProcessInvocationSpec).toBe('function')
  })

  test('D1/D2: explicit symlinked home and sqlite home produce the golden canonical key', async () => {
    const base = root()
    const realHome = join(base, 'real-codex-home')
    const linkedHome = join(base, 'reported-codex-home')
    const sqliteHome = join(base, 'sqlite-home-that-does-not-exist')
    mkdirSync(realHome, { recursive: true })
    symlinkSync(realHome, linkedHome)

    const response = await invoke(
      'resolveDesktopIdentity',
      identityRequest({
        codexHome: linkedHome,
        sqliteHome,
        rolloutPath: join(base, 'ignored', 'sessions', '2026', '09', '17', 'rollout.jsonl'),
        fallbackHomeDir: join(base, 'fallback'),
      })
    )

    const canonicalHome = realpathSync.native(realHome)
    expect(response).toEqual({
      schemaVersion: 'aspc-resolve-desktop-identity-response/v1',
      ok: true,
      identity: {
        nativeThreadId: THREAD,
        homeIdentity: canonicalHome,
        sqliteHome: resolve(sqliteHome),
        registrationKey: expectedKey(canonicalHome, THREAD),
        homeBasis: 'reported-home',
      },
    })
  })

  test('D2/D3: rollout and fallback precedence remain distinct, and identity never reads rollout metadata', async () => {
    const base = root()
    const rolloutHome = join(base, 'rollout-home')
    const nonexistentRollout = join(
      rolloutHome,
      'sessions',
      '2026',
      '09',
      '17',
      'not-created.jsonl'
    )
    const fallback = join(base, 'fallback-user')
    mkdirSync(rolloutHome, { recursive: true })
    mkdirSync(fallback, { recursive: true })

    const fromRollout = await invoke(
      'resolveDesktopIdentity',
      identityRequest({ rolloutPath: nonexistentRollout, fallbackHomeDir: fallback })
    )
    const fromFallback = await invoke(
      'resolveDesktopIdentity',
      identityRequest({ fallbackHomeDir: fallback })
    )

    expect(fromRollout).toMatchObject({
      ok: true,
      identity: {
        homeIdentity: realpathSync.native(rolloutHome),
        homeBasis: 'rollout-path',
      },
    })
    expect(fromFallback).toMatchObject({
      ok: true,
      identity: {
        homeIdentity: join(realpathSync.native(fallback), '.codex'),
        homeBasis: 'fallback-home',
      },
    })
    expect((fromRollout['identity'] as OperationResponse)['registrationKey']).not.toBe(
      (fromFallback['identity'] as OperationResponse)['registrationKey']
    )
    // The nonexistent rollout is intentional: an existing-record caller must
    // be able to stop after identity without invoking admission/header reads.
  })

  test('D4/D5: admission accepts only main Desktop metadata and native cwd wins', async () => {
    const base = root()
    const home = join(base, 'codex-home')
    const rollout = join(home, 'sessions', '2026', '09', '17', 'rollout.jsonl')
    mkdirSync(join(home, 'sessions', '2026', '09', '17'), { recursive: true })
    writeFileSync(rollout, `${admittedLine()}\n${'x'.repeat(300_000)}\n`, 'utf8')
    const canonicalHome = realpathSync.native(home)

    const response = await invoke('admitDesktopRegistration', {
      schemaVersion: 'aspc-admit-desktop-registration-request/v1',
      identity: {
        nativeThreadId: THREAD,
        homeIdentity: canonicalHome,
        sqliteHome: canonicalHome,
        registrationKey: expectedKey(canonicalHome, THREAD),
        homeBasis: 'reported-home',
      },
      rolloutPath: rollout,
      reportedWorkspaceCwd: '/workspace/hook-report',
    })

    expect(response).toEqual({
      schemaVersion: 'aspc-admit-desktop-registration-response/v1',
      ok: true,
      verdict: 'admitted',
      admitted: {
        nativeThreadId: THREAD,
        rolloutPath: rollout,
        workspaceCwd: '/workspace/native',
        metadata: {
          cliVersion: '999.0.0',
          source: 'vscode',
          threadSource: 'user',
          originator: 'Codex Desktop',
        },
      },
    })
  })

  test('D4: admission preserves the fail-closed pending check order', async () => {
    const base = root()
    const home = join(base, 'codex-home')
    const sessions = join(home, 'sessions', '2026', '09', '17')
    const archive = join(home, 'archived_sessions', 'rollout.jsonl')
    mkdirSync(sessions, { recursive: true })
    mkdirSync(join(home, 'archived_sessions'), { recursive: true })
    writeFileSync(archive, `${admittedLine()}\n`)
    const canonicalHome = realpathSync.native(home)
    const identity = {
      nativeThreadId: THREAD,
      homeIdentity: canonicalHome,
      sqliteHome: canonicalHome,
      registrationKey: expectedKey(canonicalHome, THREAD),
      homeBasis: 'reported-home',
    }
    const call = (rolloutPath: string) =>
      invoke('admitDesktopRegistration', {
        schemaVersion: 'aspc-admit-desktop-registration-request/v1',
        identity,
        rolloutPath,
        reportedWorkspaceCwd: '/workspace/reported',
      })

    expect(await call(archive)).toMatchObject({
      ok: true,
      verdict: 'pending',
      pending: { reason: 'archived_history' },
    })

    const malformed = join(sessions, 'malformed.jsonl')
    writeFileSync(malformed, 'not json\n')
    expect(await call(malformed)).toMatchObject({
      ok: true,
      verdict: 'pending',
      pending: { reason: 'native_metadata_unparsable' },
    })

    const oversizedFirstLine = join(sessions, 'oversized-first-line.jsonl')
    writeFileSync(
      oversizedFirstLine,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: THREAD,
          cwd: '/workspace/native',
          source: 'vscode',
          thread_source: 'user',
          originator: 'Codex Desktop',
          padding: 'x'.repeat(300_000),
        },
      })}\n`
    )
    expect(await call(oversizedFirstLine)).toMatchObject({
      ok: true,
      verdict: 'pending',
      pending: { reason: 'native_metadata_unparsable' },
    })

    const mismatch = join(sessions, 'mismatch.jsonl')
    writeFileSync(mismatch, `${admittedLine(OTHER_THREAD)}\n`)
    expect(await call(mismatch)).toMatchObject({
      ok: true,
      verdict: 'pending',
      pending: { reason: 'native_thread_mismatch' },
    })

    const guardian = join(sessions, 'guardian.jsonl')
    writeFileSync(
      guardian,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: THREAD,
          cwd: '/workspace/native',
          source: { subagent: { kind: 'guardian' } },
          thread_source: 'guardian_review',
          originator: 'Codex Desktop',
        },
      })}\n`
    )
    expect(await call(guardian)).toMatchObject({
      ok: true,
      verdict: 'pending',
      pending: { reason: 'spawned_subagent' },
    })
  })
})
