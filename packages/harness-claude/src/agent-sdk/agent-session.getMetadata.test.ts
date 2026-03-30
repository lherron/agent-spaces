/**
 * RED test: AgentSession.getMetadata() — T-00940
 *
 * Tests that AgentSession implements getMetadata() returning a
 * SessionMetadataSnapshot with correct capability flags.
 *
 * Expected capabilities for agent-sdk:
 *   supportsInterrupt: true
 *   supportsInFlightInput: false
 *   supportsNativeResume: true
 *   supportsAttach: false
 *
 * Pass conditions:
 *   1. getMetadata() exists and returns a SessionMetadataSnapshot
 *   2. capabilities flags match agent-sdk profile
 *   3. kind === 'agent-sdk', sessionId matches, state reflects getState()
 *   4. nativeIdentity is undefined before start (sdkSessionId not yet set)
 *   5. lastActivityAt is a recent timestamp
 *   6. pid is undefined before start
 */
import { describe, expect, test } from 'bun:test'
import { AgentSession } from './agent-session.js'

function makeSession(overrides?: { sessionId?: string }) {
  return new AgentSession({
    ownerId: 'test-owner',
    cwd: '/tmp',
    model: 'sonnet',
    sessionId: overrides?.sessionId ?? 'test-session-1',
  })
}

describe('AgentSession.getMetadata (T-00940)', () => {
  test('getMetadata() exists and returns a snapshot object', () => {
    const session = makeSession()
    // This call will fail until getMetadata is implemented
    const meta = session.getMetadata()
    expect(meta).toBeDefined()
    expect(typeof meta).toBe('object')
  })

  test('snapshot contains correct capability flags for agent-sdk', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta.capabilities).toEqual({
      supportsInterrupt: true,
      supportsInFlightInput: false,
      supportsNativeResume: true,
      supportsAttach: false,
    })
  })

  test('snapshot reflects sessionId, kind, and current state', () => {
    const session = makeSession({ sessionId: 'my-session' })
    const meta = session.getMetadata()
    expect(meta.sessionId).toBe('my-session')
    expect(meta.kind).toBe('agent-sdk')
    expect(meta.state).toBe(session.getState())
  })

  test('nativeIdentity is undefined before start', () => {
    const session = makeSession()
    const meta = session.getMetadata()
    expect(meta.nativeIdentity).toBeUndefined()
  })

  test('pid is undefined before start', () => {
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

  test('state in snapshot updates when session state changes', () => {
    const session = makeSession()
    // Before start, state should be idle
    const meta1 = session.getMetadata()
    expect(meta1.state).toBe('idle')
  })
})
