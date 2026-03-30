/**
 * RED test: CodexSession.getMetadata() — T-00940
 *
 * Tests that CodexSession implements getMetadata() returning a
 * SessionMetadataSnapshot with correct capability flags.
 *
 * Expected capabilities for codex:
 *   supportsInterrupt: false
 *   supportsInFlightInput: false
 *   supportsNativeResume: true  (via resumeThreadId)
 *   supportsAttach: false
 *
 * Pass conditions:
 *   1. getMetadata() exists and returns a SessionMetadataSnapshot
 *   2. capabilities flags match codex profile
 *   3. kind === 'codex', sessionId matches, state reflects getState()
 *   4. nativeIdentity is undefined before start (threadId not yet set)
 *   5. lastActivityAt is a recent timestamp
 *   6. pid is always undefined (codex is external process)
 */
import { describe, expect, test } from 'bun:test'
import { CodexSession } from './codex-session.js'

function makeSession(overrides?: { sessionId?: string }) {
  return new CodexSession({
    ownerId: 'test-owner',
    cwd: '/tmp',
    homeDir: '/tmp',
    sessionId: overrides?.sessionId ?? 'test-codex-1',
  })
}

describe('CodexSession.getMetadata (T-00940)', () => {
  test('getMetadata() exists and returns a snapshot object', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta).toBeDefined()
    expect(typeof meta).toBe('object')
  })

  test('snapshot contains correct capability flags for codex', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta.capabilities).toEqual({
      supportsInterrupt: false,
      supportsInFlightInput: false,
      supportsNativeResume: true,
      supportsAttach: false,
    })
  })

  test('snapshot reflects sessionId, kind, and current state', () => {
    const session = makeSession({ sessionId: 'codex-session-42' })
    const meta = session.getMetadata()
    expect(meta.sessionId).toBe('codex-session-42')
    expect(meta.kind).toBe('codex')
    expect(meta.state).toBe(session.getState())
  })

  test('nativeIdentity is undefined before start (threadId not yet set)', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta.nativeIdentity).toBeUndefined()
  })

  test('pid is always undefined for codex sessions', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta.pid).toBeUndefined()
  })

  test('lastActivityAt is a recent timestamp', () => {
    const before = Date.now()
    const session = makeSession()
    const meta = session.getMetadata()
    const after = Date.now()
    expect(meta.lastActivityAt).toBeGreaterThanOrEqual(before)
    expect(meta.lastActivityAt).toBeLessThanOrEqual(after)
  })
})
