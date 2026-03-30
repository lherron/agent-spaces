/**
 * RED test: PiSession.getMetadata() — T-00940
 *
 * Tests that PiSession implements getMetadata() returning a
 * SessionMetadataSnapshot with correct capability flags.
 *
 * Expected capabilities for pi:
 *   supportsInterrupt: false
 *   supportsInFlightInput: false
 *   supportsNativeResume: false
 *   supportsAttach: false
 *
 * Pass conditions:
 *   1. getMetadata() exists and returns a SessionMetadataSnapshot
 *   2. capabilities flags match pi profile (all false)
 *   3. kind === 'pi', sessionId matches, state reflects getState()
 *   4. nativeIdentity is always undefined (pi has no external session id)
 *   5. lastActivityAt is a recent timestamp
 *   6. pid is always undefined
 */
import { describe, expect, test } from 'bun:test'
import { PiSession } from './pi-session.js'

function makeSession(overrides?: { sessionId?: string }) {
  return new PiSession({
    ownerId: 'test-owner',
    cwd: '/tmp',
    sessionId: overrides?.sessionId ?? 'test-pi-1',
  })
}

describe('PiSession.getMetadata (T-00940)', () => {
  test('getMetadata() exists and returns a snapshot object', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta).toBeDefined()
    expect(typeof meta).toBe('object')
  })

  test('snapshot contains correct capability flags for pi (all false)', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta.capabilities).toEqual({
      supportsInterrupt: false,
      supportsInFlightInput: false,
      supportsNativeResume: false,
      supportsAttach: false,
    })
  })

  test('snapshot reflects sessionId, kind, and current state', () => {
    const session = makeSession({ sessionId: 'pi-session-99' })
    const meta = session.getMetadata()
    expect(meta.sessionId).toBe('pi-session-99')
    expect(meta.kind).toBe('pi')
    expect(meta.state).toBe(session.getState())
  })

  test('nativeIdentity is always undefined for pi sessions', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta.nativeIdentity).toBeUndefined()
  })

  test('pid is always undefined for pi sessions', () => {
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
